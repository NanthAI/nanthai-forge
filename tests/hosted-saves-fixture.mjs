// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { saveBytes, savePin, buildSavePages } from '../dist/hosted-save.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { signSourceJobCallback } from '../dist/hosted-source-job.js';
export const api = await import(moduleUrl('../convex/projectHostedSaves.ts'));
export const jobApi = await import(moduleUrl('../convex/projectHostedSaveJobs.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const callbacks = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
export const maxima = {};
export async function saveFixture() {
  const s = lanesFixture(),
    objects = new Map(),
    scheduled = [];
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      return await s.call(
        name,
        {
          _handler: async (ctx, input) => {
            ctx.scheduler = {
              runAfter: async (_delay, ref, args) => {
                scheduled.push({ name: getFunctionName(ref), args });
                return 'task';
              },
            };
            return fn._handler(ctx, input);
          },
        },
        args,
        actor,
      );
    } finally {
      for (const c of s.counts.filter(c => c.name === name)) {
        assert(
          c.documents <= (name === 'stage' ? 140 : 100) && c.ranges <= (name === 'stage' ? 140 : 100),
          `${name}: per-function reads`,
        );
        assert(c.readBytes < 512 * 1024 && c.writeBytes < 512 * 1024, `${name}: metadata only`);
        assert(
          !c.touched.some(table =>
            [
              'projectBackups',
              'projectWorkRecords',
              'projectWorkEvents',
              'projectWorkGenerations',
              'projectHostedChannels',
            ].includes(table),
          ),
          `${name}: no Work/history hydration`,
        );
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const key of Object.keys(max)) max[key] = Math.max(max[key], c[key]);
      }
    }
  };
  const run = (name, fn, args) => call(name, { _handler: fn }, args);
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    if (!objects.has(pin.sha256))
      s.insert('projectObjects', {
        projectId,
        digest: pin.sha256,
        size: pin.size,
        removed: false,
        nonce: randomUUID(),
        location: 'r2',
        r2Committed: true,
        r2Key: `v1/p/${projectId}/o/${pin.sha256}`,
      });
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const original = put('original'),
    hidden = put('unmaterialized');
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [
      { path: 'a.txt', blob: original.sha256, mode: 'file' },
      { path: 'hidden.txt', blob: hidden.sha256, mode: 'file' },
    ],
    message: 'seed',
    at: '2026-01-01T00:00:00.000Z',
  };
  const baseline = put(JSON.stringify(state)),
    laneId = randomUUID(),
    intentId = randomUUID();
  const identity = { projectId, actor: 'owner', authorityEpoch: 1 };
  const lane = {
    kind: 'lane',
    id: laneId,
    intentId,
    actor: 'owner',
    version: 0,
    at: state.at,
    base: { head: baseline.sha256, receiptId: 'main-0' },
    head: baseline.sha256,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  };
  await run('seedLane', (ctx, input) => records.writeHostedRecord(ctx, input), {
    ...identity,
    expectedVersion: null,
    record: lane,
  });
  const expected = { head: baseline.sha256, version: 0, sourceVersion: 0, lifecycleVersion: 0 };
  const prepare = async (changes, overrides = {}) => {
    const built = buildSavePages(changes);
    const request = {
      operationId: randomUUID(),
      laneId,
      authorityEpoch: 1,
      expected,
      message: 'synthetic save',
      pages: built.root,
      pageCount: built.pages.length,
      changeCount: changes.length,
      ...overrides,
    };
    const result = JSON.parse(
      await call('prepare', api.prepare, { projectId, request: JSON.stringify(request) }),
    );
    return { request, result, pages: built.pages };
  };
  const stage = async x => {
    for (const [index, page] of x.pages.entries()) {
      put(saveBytes(page.value));
      await call('stage', api.stage, {
        projectId,
        operationId: x.request.operationId,
        index,
        page: JSON.stringify(page.value),
      });
    }
  };
  const submit = async x => {
    const progress = JSON.parse(
      await call('progress', api.progress, { projectId, operationId: x.request.operationId }),
    );
    if (progress.input) put(saveBytes(progress.input));
    const before = Object.fromEntries(
      ['FORGE_SOURCE_WORKER', 'FORGE_SOURCE_RUNTIME', 'FORGE_SOURCE_KEY_ID'].map(k => [k, process.env[k]]),
    );
    Object.assign(process.env, {
      FORGE_SOURCE_WORKER: 'fixed-worker',
      FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
      FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
    });
    try {
      return JSON.parse(
        await call('submit', jobApi.submit, { projectId, operationId: x.request.operationId }),
      );
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const work = async x => {
    const saved = JSON.parse(
      await call('progress', api.progress, { projectId, operationId: x.request.operationId }),
    );
    const input = savePin(saved.input),
      reads = [];
    const result = await buildHostedSourceState(input, {
      async read(pin) {
        reads.push(pin);
        assert(objects.has(pin.sha256));
        return [objects.get(pin.sha256)];
      },
      async upload(pin, stream) {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const actual = put(Buffer.concat(chunks));
        assert.deepEqual(actual, pin);
      },
    });
    const save = [...s.tables.projectHostedSaves.values()].find(
        row => row.operationId === x.request.operationId,
      ),
      jobId = save.jobId;
    const owner = randomUUID();
    const claimed = await run('claim', (ctx, input) => jobs.claimSourceJob(ctx, input), {
      projectId,
      jobId,
      owner,
      leaseMs: 60000,
    });
    await run('reserve', (ctx, input) => jobs.advanceSourceJob(ctx, input), {
      projectId,
      jobId,
      owner,
      token: claimed.control.lease.token,
      command: { kind: 'reserve', recovery: false },
    });
    const job = await run('loadJob', (ctx, input) => jobs.loadSourceJob(ctx, input.projectId, input.jobId), {
      projectId,
      jobId,
    });
    const callback = {
      schema: 1,
      projectId,
      jobId,
      operationId: job.operationId,
      attempt: job.attempt,
      fence: job.fence,
      authorityEpoch: 1,
      inputDigest: job.inputDigest,
      provider: job.control.provider,
      worker: job.control.worker,
      runtime: job.control.runtime,
      executionId: 'fake-execution',
      result: { status: 'completed', output: result.output },
    };
    const secret = 'local-synthetic-signing-key',
      prior = process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC;
    process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC = secret;
    try {
      await call('callback', callbacks.callback, {
        projectId,
        callback: JSON.stringify(callback),
        signature: signSourceJobCallback(callback, secret),
      });
    } finally {
      if (prior === undefined) delete process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC;
      else process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC = prior;
    }
    return { ...result, jobId, manifest: objects.get(result.output.sha256).toString(), reads };
  };
  const publish = output =>
    call('publish', jobApi.publish, { projectId, jobId: output.jobId, result: output.manifest }).then(
      JSON.parse,
    );
  const change = (bytes = 'changed', mode = 'file') => {
    const pin = put(bytes);
    return {
      path: 'a.txt',
      before: { blob: original.sha256, mode: 'file' },
      after: { blob: pin.sha256, mode, content: { object: pin, recipe: null } },
    };
  };
  return {
    ...s,
    call,
    run,
    put,
    objects,
    projectId,
    laneId,
    state,
    expected,
    baseline,
    original,
    hidden,
    prepare,
    stage,
    submit,
    work,
    publish,
    change,
    scheduled,
  };
}
