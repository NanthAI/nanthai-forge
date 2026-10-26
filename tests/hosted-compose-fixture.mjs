// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { signSourceJobCallback } from '../dist/hosted-source-job.js';
export const api = await import(moduleUrl('../convex/projectHostedCompose.ts'));
export const jobApi = await import(moduleUrl('../convex/projectHostedComposeJobs.ts'));
export const transfers = await import(moduleUrl('../convex/projectHostedSaveTransfers.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const callbacks = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
export const code = value => error => (error.data?.code ?? error.code) === value;
export const maxima = {};
export async function composeFixture() {
  const s = lanesFixture(),
    objects = new Map(),
    scheduled = [];
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const auth = { projectId, actor: 'owner', authorityEpoch: 1 };
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      return await s.call(
        name,
        {
          _handler: (ctx, input) => {
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
        const bound = name === 'composeStage' ? 1200 : 100;
        assert(c.ranges <= bound && c.documents <= bound, `${name}: bounded reads`);
        assert(c.readBytes < 2 * 1024 * 1024 && c.writeBytes < 512 * 1024, `${name}: metadata bytes`);
        assert(
          !c.touched.some(t =>
            ['projectBackups', 'projectWorkRecords', 'projectWorkEvents', 'projectWorkGenerations'].includes(
              t,
            ),
          ),
          `${name}: no history hydration`,
        );
        if (name === 'composePublish')
          assert(
            !c.touched.some(t =>
              [
                'projectHostedChannels',
                'projectHostedComposePages',
                'projectHostedComposeSelections',
              ].includes(t),
            ),
            'constant-size final publication',
          );
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const key of Object.keys(max)) max[key] = Math.max(max[key], c[key]);
      }
    }
  };
  const run = (name, fn, args) => call(name, { _handler: fn }, args);
  const put = value => {
    const bytes = Buffer.from(value),
      pin = { sha256: digest(bytes), size: bytes.length };
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
  const register = pin => {
    if (![...s.tables.projectHostedStates.values()].some(r => r.head === pin.sha256))
      s.insert('projectHostedStates', {
        projectId,
        head: pin.sha256,
        size: pin.size,
        input: 'a'.repeat(64),
        jobId: randomUUID(),
        output: 'b'.repeat(64),
      });
  };
  const state = (files, parents = [], message = 'synthetic') =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
        parents,
        message,
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  const file = (path, bytes, mode = 'file') => ({ path, blob: put(bytes).sha256, mode });
  const baseFile = file('a.txt', 'a\nb\nc\n'),
    hidden = file('hidden.bin', Buffer.alloc(4096, 0));
  const baseline = state([baseFile, hidden]);
  register(baseline);
  const main = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head: baseline.sha256,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const mainId = s.insert('projectHostedChannels', {
    projectId,
    operationId: randomUUID(),
    name: 'main',
    selection: JSON.stringify(main),
  });
  const intentId = randomUUID();
  await run('seedIntent', records.writeHostedRecord, {
    ...auth,
    expectedVersion: null,
    record: {
      kind: 'intent',
      id: intentId,
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'Compose synthetic Lanes',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: baseline.sha256, receiptId: 'main-0' },
      status: 'active',
    },
  });
  const lane = async (pin, overrides = {}) => {
    register(pin);
    const record = {
      kind: 'lane',
      id: randomUUID(),
      intentId,
      actor: 'owner',
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      base: { head: baseline.sha256, receiptId: 'main-0' },
      head: pin.sha256,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      authorityEpoch: 1,
      ...overrides,
    };
    await run('seedLane', records.writeHostedRecord, { ...auth, expectedVersion: null, record });
    return {
      laneId: record.id,
      head: record.head,
      version: record.version,
      sourceVersion: record.sourceVersion,
      lifecycleVersion: record.lifecycleVersion,
      state: { object: pin, recipe: null },
    };
  };
  const advance = async entry =>
    run('advanceLane', async ctx => {
      const row = await records.readHostedRecord(ctx, { ...auth, kind: 'lane', key: entry.laneId });
      const old = JSON.parse(row.value);
      return records.writeHostedRecord(ctx, {
        ...auth,
        expectedVersion: old.version,
        record: { ...old, version: old.version + 1, sourceVersion: old.sourceVersion + 1 },
      });
    });
  const selection = (inputs, dependencies = [], overrides = {}) => {
    const i = buildComposePages(inputs),
      d = buildComposePages(dependencies);
    return {
      request: {
        operationId: randomUUID(),
        intentId,
        authorityEpoch: 1,
        expectedMain: { head: main.head, receiptId: main.receipt.id },
        inputs: i.manifest,
        dependencies: d.manifest,
        message: 'Native review composition',
        ...overrides,
      },
      pages: { inputs: i.pages, dependencies: d.pages },
    };
  };
  const prepare = x =>
    call('composePrepare', api.prepare, { projectId, request: JSON.stringify(x.request) }).then(JSON.parse);
  const stage = async x => {
    for (const kind of ['inputs', 'dependencies'])
      for (const [index, page] of x.pages[kind].entries()) {
        put(saveBytes(page.value));
        await call('composeStage', api.stage, {
          projectId,
          operationId: x.request.operationId,
          kind,
          index,
          page: JSON.stringify(page.value),
        });
      }
  };
  const progress = x =>
    call('composeProgress', api.progress, { projectId, operationId: x.request.operationId }).then(JSON.parse);
  const submit = async x => {
    const p = await progress(x);
    if (p.input) put(saveBytes(p.input));
    const env = {
      FORGE_SOURCE_WORKER: 'fixed-worker',
      FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
      FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
    };
    const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      return JSON.parse(
        await call('composeSubmit', jobApi.submit, { projectId, operationId: x.request.operationId }),
      );
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const activate = async jobId => {
    const owner = randomUUID(),
      claim = await run('claim', jobs.claimSourceJob, { projectId, jobId, owner, leaseMs: 60000 });
    await run('reserve', jobs.advanceSourceJob, {
      projectId,
      jobId,
      owner,
      token: claim.control.lease.token,
      command: { kind: 'reserve', recovery: false },
    });
    return run('loadJob', ctx => jobs.loadSourceJob(ctx, projectId, jobId));
  };
  const callback = async (job, result) => {
    const body = {
      schema: 1,
      projectId,
      jobId: job.id,
      operationId: job.operationId,
      attempt: job.attempt,
      fence: job.fence,
      authorityEpoch: 1,
      inputDigest: job.inputDigest,
      provider: job.control.provider,
      worker: job.control.worker,
      runtime: job.control.runtime,
      executionId: 'synthetic-execution',
      result,
    };
    const key = 'synthetic-compose-key',
      prior = process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC;
    process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC = key;
    try {
      return JSON.parse(
        await call('callback', callbacks.callback, {
          projectId,
          callback: JSON.stringify(body),
          signature: signSourceJobCallback(body, key),
        }),
      );
    } finally {
      if (prior === undefined) delete process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC;
      else process.env.FORGE_SOURCE_JOB_KEY_SYNTHETIC = prior;
    }
  };
  const compute = async (plan, mutate = x => x) => {
    const input = put(saveBytes(mutate(plan))),
      reads = [],
      descriptors = [];
    const result = await buildHostedSourceState(input, {
      async describe(id) {
        descriptors.push(id);
        assert(objects.has(id), 'only project source');
        return { object: { sha256: id, size: objects.get(id).length }, recipe: null };
      },
      async read(pin) {
        reads.push(pin);
        assert(objects.has(pin.sha256));
        return [objects.get(pin.sha256)];
      },
      async upload(pin, stream) {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.deepEqual(put(Buffer.concat(chunks)), pin);
      },
    });
    return { ...result, manifest: objects.get(result.output.sha256).toString(), reads, descriptors };
  };
  const work = async x => {
    const output = await compute((await progress(x)).input);
    const row = [...s.tables.projectHostedComposes.values()].find(
        r => r.operationId === x.request.operationId,
      ),
      job = await activate(row.jobId);
    await callback(job, { status: 'completed', output: output.output });
    return { ...output, jobId: job.id };
  };
  const publish = output =>
    call('composePublish', jobApi.publish, { projectId, jobId: output.jobId, result: output.manifest }).then(
      JSON.parse,
    );
  const moveMain = (head = main.head, receiptId = 'main-1') =>
    s.patch('projectHostedChannels', mainId, {
      selection: JSON.stringify({ ...main, head, receipt: { ...main.receipt, id: receiptId } }),
    });
  return {
    ...s,
    call,
    run,
    projectId,
    intentId,
    main,
    auth,
    objects,
    scheduled,
    put,
    register,
    state,
    file,
    baseFile,
    hidden,
    baseline,
    lane,
    advance,
    selection,
    prepare,
    stage,
    progress,
    submit,
    activate,
    callback,
    compute,
    work,
    publish,
    moveMain,
  };
}
