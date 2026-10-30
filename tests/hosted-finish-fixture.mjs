// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { composeFixture, jobApi as composeJobs } from './hosted-compose-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { driver as landingDriver, control as landingControl } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { analyzeCrossHeadReuse } from '../dist/hosted-cross-head-analysis.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { digest } from '../dist/hash.js';
import { convexStoreBlob } from './convex-storage-fake.mjs';
export const desired = await import(moduleUrl('../convex/projectHostedLandingDesired.ts'));
export const driver = await import(moduleUrl('../convex/projectHostedFinishDriver.ts'));
export const api = await import(moduleUrl('../convex/projectHostedFinish.ts'));
export const control = await import(moduleUrl('../convex/projectHostedFinishControl.ts'));
export const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
export const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const stallApi = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const batchAbandon = await import(moduleUrl('../convex/projectHostedBatchAbandon.ts'));
const convexSourceModules = Object.fromEntries(
  await Promise.all(
    [
      'projectConvexSource',
      'projectConvexSourceTask',
      'projectConvexSourceFanout',
      'projectConvexSourceStore',
      'projectConvexSourceObjects',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
const sourceJobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const reuseStore = await import(moduleUrl('../convex/projectHostedReuseStore.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const maxima = {};
export const code = value => error => (error.data?.code ?? error.code) === value;
export async function compose(c, selection) {
  await c.prepare(selection);
  await c.stage(selection);
  await c.submit(selection);
  return (await c.publish(await c.work(selection))).outcome.result;
}
export async function finishFixture(
  t,
  {
    overlap = false,
    inputCount = 1,
    selectedFileCount = 0,
    fileCount = 3,
    baselineFiles = [],
    selectedFiles = null,
    mainFiles = null,
  } = {},
) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const c = await composeFixture({ baselineFiles });
  const extraBase = JSON.parse(c.objects.get(c.baseline.sha256)).files.filter(
    file => !['a.txt', 'hidden.bin'].includes(file.path),
  );
  const apply = (files, delta) => {
    const next = new Map(files.map(file => [file.path, file]));
    for (const [path, text] of delta) {
      if (text === null) next.delete(path);
      else next.set(path, c.file(path, text));
    }
    return [...next.values()];
  };
  const largePin = selectedFileCount ? c.put(Buffer.alloc(100 * 1024, 65)) : null;
  const largeFiles = Array.from({ length: selectedFileCount }, (_, i) => ({
    path: `deep/a/b/c/d/${String(i).padStart(6, '0')}`,
    blob: largePin.sha256,
    mode: 'file',
  }));
  const selectedState = c.state(
    [
      overlap ? c.file('a.txt', 'ours\nb\nc\n') : c.baseFile,
      c.hidden,
      ...apply(extraBase, selectedFiles ?? [['selected.txt', 'selected\n']]),
      ...largeFiles,
      ...Array.from({ length: Math.max(0, fileCount - 3) }, (_, i) =>
        c.file(`extra-${i}.txt`, `selected ${i}\n`),
      ),
    ],
    [c.baseline.sha256],
  );
  const lane = await c.lane(selectedState),
    lanes = [lane];
  for (let i = 1; i < inputCount; i++) lanes.push(await c.lane(c.baseline));
  const selection = c.selection(lanes);
  const candidate = await compose(c, selection);
  const f = await acceptanceFixture({
    store: c,
    projectId: c.projectId,
    candidate,
    state: { sha256: candidate.result.head, size: c.objects.get(candidate.result.head).length },
  });
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const blobs = new Map(),
    metrics = {
      planUploads: [],
      legacyPlanWrites: [],
      transfers: 0,
      downloadBytes: 0,
      uploadBytes: 0,
      sourceJobs: 0,
      ticks: 0,
      stepCalls: [],
      convexSourceCalls: [],
      convexStorageCalls: 0,
    };
  const sourceStorage = {
    async getMetadata(id) {
      return blobs.get(id)?.metadata ?? null;
    },
    async getUrl(id) {
      return `https://metadata.invalid/${blobs.get(id)?.metadata.sha256 ?? id}`;
    },
    async get(id) {
      metrics.convexStorageCalls++;
      const row = blobs.get(id);
      return row ? new Blob([c.objects.get(row.metadata.sha256)]) : null;
    },
    async store(blob, options) {
      metrics.convexStorageCalls++;
      const bytes = await convexStoreBlob(blob, options),
        sha256 = digest(bytes),
        id = `source-${randomUUID()}`;
      blobs.set(id, { metadata: { sha256, size: bytes.length } });
      c.objects.set(sha256, bytes);
      return id;
    },
  };
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.storage = sourceStorage;
    ctx.scheduler = {
      runAfter: async (delay, ref, args) =>
        ctx.db.insert('_scheduled_functions', {
          name: getFunctionName(ref),
          args: [args],
          scheduledTime: now + delay,
          state: { kind: 'pending' },
        }),
      cancel: async id => {
        const old = await ctx.db.get(id);
        if (old && !['success', 'failed'].includes(old.state.kind))
          await ctx.db.patch(id, { state: { kind: 'canceled' } });
      },
    };
  });
  const tx = async (name, fn, args, actor = 'owner') => {
    try {
      return await f.transaction(name, fn, args, actor);
    } finally {
      for (const count of f.counts.filter(r => r.name === name)) {
        assert(count.ranges <= 1600 && count.documents <= 1600, `${name}: bounded reads`);
        assert(count.readBytes < 2 * 1024 * 1024 && count.writeBytes < 512 * 1024, `${name}: metadata bytes`);
        assert(
          !count.touched.some(k =>
            [
              'projectWorkRecords',
              'projectWorkGenerations',
              'projectWorkEvents',
              'projectBackups',
              'projectHostedCheckShards',
            ].includes(k),
          ),
          `${name}: no Work/history/shard hydration`,
        );
        if (name === 'finishStep')
          assert(count.ranges <= 120 && count.documents <= 120, 'constant-size finish control');
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const key of Object.keys(max)) max[key] = Math.max(max[key], count[key]);
      }
      for (const row of f.tables.projectHostedFinishes.values()) {
        const fields = schema.tables.projectHostedFinishes.export().documentType.value;
        assert(Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields));
        for (const [key, field] of Object.entries(fields)) assert(field.optional || key in row, key);
      }
    }
  };
  const request = overrides =>
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      check: {
        kind: 'request',
        checkId: f.rawChecks.checkId,
        expectedDefinition: f.rawChecks.definition.digest,
        expectedConfiguration: f.rawChecks.configuration.digest,
        expectedEnvironment: f.rawChecks.runner.environmentFingerprint,
      },
      finish: { composeOperationId: selection.request.operationId, after: null },
      ...overrides,
    });
  const enqueue = r =>
    tx('finishEnqueue', landingApi.enqueue, { projectId: f.projectId, request: JSON.stringify(r) }).then(
      JSON.parse,
    );
  const current = id =>
    tx('finishStatus', api.status, { projectId: f.projectId, submissionId: id, priorityInfo: 1 }).then(
      JSON.parse,
    );
  const row = id => [...f.tables.projectHostedFinishes.values()].find(x => x.submissionId === id);
  const pending = () =>
    [...f.tables._scheduled_functions.values()]
      .filter(x => x.state.kind === 'pending')
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  const runReuseAction = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectHostedReuse:prove');
    const context = await tx('reuseContext', reuseStore.context, {
      projectId: f.projectId,
      submissionId: args.submissionId,
    });
    if (!context) return null;
    const owner = await tx('reuseClaim', reuseStore.claim, { ...args, owner: randomUUID() });
    if (!owner) return null;
    let proof = null;
    try {
      proof = await analyzeCrossHeadReuse(context.basis, context.selection, async hashes =>
        hashes.map(hash => c.objects.get(hash)),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return tx('reuseComplete', reuseStore.complete, {
      ...args,
      owner,
      proof: proof ? JSON.stringify(proof) : null,
    });
  };
  const execute = async (task = pending()[0], stop = null) => {
    assert(task, 'pending task');
    now = Math.max(now, task.scheduledTime);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    const input = task.args[0];
    metrics.ticks++;
    try {
      if (task.name === 'projectHostedFinishDriver:drive') {
        if (stop === 'before-step') return null;
        const calls = [];
        metrics.stepCalls.push(calls);
        await driver.drive._handler(
          {
            runAction: runReuseAction,
            runMutation: async (ref, args) => {
              const name = getFunctionName(ref);
              calls.push(name);
              if (name.endsWith(':step')) {
                const result = await tx('finishStep', driver.step, args);
                if (stop === 'after-step') {
                  const e = new Error('synthetic crash after durable step');
                  e.command = result;
                  throw e;
                }
                return result;
              }
              if (stop === 'before-resume') throw new Error('synthetic crash after IO');
              return tx('finishResume', driver.resume, args);
            },
            storage: {
              store: async (blob, options) => {
                const bytes = await convexStoreBlob(blob, options),
                  sha256 = digest(bytes),
                  id = `blob-${randomUUID()}`;
                blobs.set(id, { metadata: { sha256, size: bytes.length } });
                c.objects.set(sha256, bytes);
                metrics.uploadBytes += bytes.length;
                metrics.legacyPlanWrites.push({ digest: sha256, size: bytes.length });
                return id;
              },
            },
          },
          input,
        );
      } else if (task.name === 'projectHostedLandingStall:alarm') {
        await tx('landingAlarm', stallApi.alarm, input);
      } else if (task.name === 'projectHostedBatchAbandon:reselect') {
        await tx('batchAbandon', batchAbandon.reselect, input);
      } else if (task.name === 'projectHostedLandingDesired:drive') {
        await desired.drive._handler(
          {
            runMutation: (ref, args) => {
              const name = getFunctionName(ref).split(':').at(-1);
              return tx(`desired-${name}`, desired[name], args);
            },
          },
          input,
        );
      } else if (task.name === 'projectHostedLandingDriver:drive') {
        const claim = await tx('finishLandingClaim', landingDriver.claim, input);
        if (claim) await tx('finishLandingAdvance', landingDriver.advance, claim);
      } else if (task.name === 'projectHostedLandingDriver:checkWake') {
        await tx('finishCheckWake', landingDriver.checkWake, input);
      } else if (task.name === 'projectHostedFinishDriver:dependents') {
        await tx('finishDependents', driver.dependents, input);
      } else if (task.name === 'projectHostedAcceptance:complete') {
        await f.materialize(input.receiptId);
      } else if (
        task.name.startsWith('projectConvexSource:') ||
        task.name.startsWith('projectConvexSourceTask:') ||
        task.name.startsWith('projectConvexSourceFanout:')
      ) {
        if (stop === 'before-source' && task.name.endsWith(':dispatch'))
          throw new Error('synthetic crash before source job');
        // The platform error the 2026-10-30 queue stall step action died on.
        if (stop === 'step-fetch-failed' && task.name === 'projectConvexSource:step')
          throw new TypeError('fetch failed');
        metrics.convexSourceCalls.push(task.name);
        if (task.name.endsWith(':dispatch')) metrics.sourceJobs++;
        await convexSourceModules[task.name.split(':')[0]][task.name.split(':')[1]]._handler(
          {
            storage: sourceStorage,
            runMutation: (ref, args) => {
              const name = getFunctionName(ref),
                [file, method] = name.split(':');
              metrics.convexSourceCalls.push(name);
              return tx(name, convexSourceModules[file][method], args);
            },
          },
          input,
        );
        if (stop === 'after-source-callback' && task.name.endsWith(':dispatch')) {
          // Advance the exact source steps before simulating a lost completed reply.
          while (
            pending().some(t => t.name.startsWith('projectConvexSource') && !t.name.endsWith(':dispatch'))
          ) {
            await execute(
              pending().find(t => t.name.startsWith('projectConvexSource') && !t.name.endsWith(':dispatch')),
            );
          }
          throw new Error('synthetic crash after source callback');
        }
      } else if (task.name === 'projectHostedComposeJobs:complete') {
        const job = await tx(
          'finishLoadJob',
          { _handler: ctx => sourceJobs.loadSourceJob(ctx, f.projectId, input.jobId) },
          {},
        );
        await tx('finishSourcePublish', composeJobs.publish, {
          projectId: f.projectId,
          jobId: input.jobId,
          result: c.objects.get(job.output.sha256).toString(),
        });
        if (stop === 'after-source-publish') throw new Error('synthetic crash after source publication');
      } else assert.fail(`Unexpected task ${task.name}`);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } catch (error) {
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      throw error;
    }
  };
  const drain = async () => {
    let steps = 0;
    while (pending().length) {
      assert(++steps <= 100, 'no idle poller or busy loop');
      await execute();
    }
    return steps;
  };
  const passChecks = async () => {
    for (const row of [...f.tables.projectHostedCheckRuns.values()]) {
      const run = JSON.parse(row.value);
      if (run.status === 'queued') await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
  };
  const moveMain = ({ overlap = false, sameHead = false } = {}) => {
    const old = f.currentMain(),
      state = sameHead
        ? { sha256: old.head }
        : c.state(
            [
              overlap ? c.file('a.txt', 'theirs\nb\nc\n') : c.baseFile,
              c.hidden,
              ...apply(extraBase, mainFiles ?? [['accepted.txt', 'already accepted\n']]),
            ],
            [old.head],
          );
    if (!sameHead) c.register(state);
    f.patch('projectHostedChannels', f.mainId, {
      selection: JSON.stringify({
        ...old,
        head: state.sha256,
        receipt: { ...old.receipt, id: randomUUID() },
      }),
    });
    return f.currentMain();
  };
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method === 'PUT') {
      assert.equal(init.headers['if-none-match'], '*');
      const bytes = Buffer.from(init.body),
        hash = digest(bytes);
      assert.equal(init.headers['content-length'], String(bytes.length));
      assert.equal(init.headers['x-amz-checksum-sha256'], Buffer.from(hash, 'hex').toString('base64'));
      const key = new URL(url).pathname.split('/').at(-1);
      assert.equal(key, hash);
      if (c.objects.has(hash)) return new Response(null, { status: 412 });
      c.objects.set(hash, bytes);
      metrics.planUploads.push({ digest: hash, size: bytes.length });
      metrics.uploadBytes += bytes.length;
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'HEAD') {
      const hash = new URL(url).pathname.split('/').at(-1),
        bytes = c.objects.get(hash);
      return new Response(null, {
        status: bytes ? 200 : 404,
        headers: bytes
          ? {
              'content-length': String(bytes.length),
              'x-amz-checksum-sha256': Buffer.from(hash, 'hex').toString('base64'),
            }
          : {},
      });
    }
    const hash = new URL(url).pathname.split('/').at(-1),
      bytes = c.objects.get(hash);
    assert(bytes, 'metadata request only targets a synthetic committed object');
    metrics.transfers++;
    metrics.downloadBytes += bytes.length;
    return new Response(bytes);
  });
  t.after(() => {
    assert.notEqual(globalThis.fetch, originalFetch);
  });
  return {
    ...f,
    c,
    tx,
    candidate,
    lane,
    selection,
    request,
    enqueue,
    current,
    row,
    pending,
    execute,
    drain,
    passChecks,
    runReuseAction,
    moveMain,
    metrics,
    advanceClock: ms => {
      now += ms;
    },
  };
}
