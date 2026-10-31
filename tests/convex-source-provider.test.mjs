// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture, api as saveApi, jobApi as saveJobs } from './hosted-saves-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { sourceWorkerPlan } from '../dist/convex-source-provider.js';
import { sourceDispatch } from '../dist/hosted-source-job-controller.js';
import { digest } from '../dist/hash.js';
import { convexStoreBlob } from './convex-storage-fake.mjs';
import { interceptDefaultR2, storedBytes } from './default-r2.mjs';
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
const worker = await import(moduleUrl('../convex/projectConvexSource.ts'));
const objects = await import(moduleUrl('../convex/projectConvexSourceObjects.ts'));
const jobApi = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
async function fixture() {
  const s = await saveFixture(),
    blobs = new Map(),
    invocations = [],
    failures = new Set(),
    hooks = { failInsert: false, failStore: false, scheduled: 'pending' };
  const functions = {
    'projectConvexSourceStore:dispatch': store.dispatch,
    'projectConvexSourceStore:start': store.start,
    'projectConvexSourceStore:lookup': store.lookup,
    'projectConvexSourceStore:stage': store.stage,
    'projectConvexSourceStore:begin': store.begin,
    'projectConvexSourceStore:commit': store.commit,
    'projectConvexSourceObjects:resolve': objects.resolve,
    'projectSourceJobApi:claim': jobApi.claim,
    'projectSourceJobApi:advance': jobApi.advance,
    'projectHostedSaveJobs:resultDownload': saveJobs.resultDownload,
    'projectHostedSaveJobs:publish': saveJobs.publish,
  };
  let stores = 0,
    gets = 0;
  const storage = {
    async get(id) {
      gets++;
      return blobs.get(id) ?? null;
    },
    async store(blob, options) {
      await convexStoreBlob(blob, options);
      if (hooks.failStore) {
        hooks.failStore = false;
        throw Error('Error uploading file: synthetic platform failure');
      }
      const id = `blob-${++stores}`;
      blobs.set(id, blob);
      return id;
    },
    async getMetadata(id) {
      const blob = blobs.get(id);
      return blob ? { size: blob.size, sha256: digest(Buffer.from(await blob.arrayBuffer())) } : null;
    },
    async getUrl(id) {
      return blobs.has(id) ? `https://synthetic.invalid/${id}` : null;
    },
  };
  const call = async (name, fn, input) => {
    invocations.push(name);
    const value = await s.call(name, fn, input);
    if (failures.delete(name)) throw Error('synthetic lost reply');
    return value;
  };
  s.decorateContext(ctx => {
    ctx.storage = storage;
    ctx.db.system = {
      get: async () => {
        const kind = hooks.scheduled;
        hooks.scheduled = 'pending';
        return { state: { kind } };
      },
    };
    const insert = ctx.db.insert;
    ctx.db.insert = async (table, value) => {
      if (hooks.failInsert && table === 'projectSourceSteps')
        throw Error('synthetic schedule transaction failure');
      return insert(table, value);
    };
    ctx.runMutation = async (ref, input) => {
      const name = getFunctionName(ref);
      assert(functions[name], name);
      // Real Convex rejects fields the args validator does not name.
      const spec = JSON.parse(functions[name].exportArgs());
      if (spec.type === 'object')
        for (const key of Object.keys(input ?? {})) assert(key in spec.value, `${name}: extra field ${key}`);
      return call(name, functions[name], input);
    };
  });
  const convert = () => {
    for (const row of s.tables.projectObjects.values()) {
      const id = `source-${row.digest}`;
      blobs.set(id, new Blob([s.objects.get(row.digest)]));
      s.patch('projectObjects', row._id, {
        storageId: id,
        location: undefined,
        r2Key: undefined,
        r2Committed: undefined,
      });
    }
  };
  const changes = Array.from({ length: 10 }, (_, i) =>
    i === 0
      ? s.change('changed 0')
      : (() => {
          const pin = s.put(`changed ${i}`);
          return {
            path: `added-${i}`,
            before: null,
            after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
          };
        })(),
  );
  const x = await s.prepare(changes);
  await s.stage(x);
  const progress = JSON.parse(
    await s.call('progress', saveApi.progress, {
      projectId: s.projectId,
      operationId: x.request.operationId,
    }),
  );
  s.put(saveBytes(progress.input));
  convert();
  const savedEnv = {};
  for (const key of [
    'FORGE_SOURCE_PROVIDER',
    'FORGE_SOURCE_WORKER',
    'FORGE_SOURCE_RUNTIME',
    'FORGE_SOURCE_KEY_ID',
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const submit = () =>
    call('submitConvex', saveJobs.submit, { projectId: s.projectId, operationId: x.request.operationId });
  const load = () =>
    s.run(
      'load',
      ctx => jobs.loadSourceJob(ctx, s.projectId, [...s.tables.projectHostedSaves.values()][0].jobId),
      {},
    );
  // Source bytes go to R2: a platform failure is a failed PUT.
  const restoreR2 = interceptDefaultR2((input, init, serve) => {
    if (hooks.failStore && init?.method === 'PUT') {
      hooks.failStore = false;
      throw Error('fetch failed: synthetic platform failure');
    }
    return serve(input, init);
  });
  const restore = () => {
    restoreR2();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const execute = async task => {
    const fn =
      task.name === 'projectConvexSource:dispatch'
        ? worker.dispatch
        : task.name === 'projectConvexSource:step'
          ? worker.step
          : null;
    assert(fn, task.name);
    return call(task.name, fn, task.args);
  };
  return {
    ...s,
    call,
    execute,
    submit,
    load,
    restore,
    invocations,
    blobs,
    storage,
    failures,
    hooks,
    countsIO: () => ({ stores, gets }),
  };
}
test('Convex is the fixed default; retired Modal selection is refused without network calls', () => {
  assert.equal(sourceWorkerPlan({}).provider, 'convex');
  assert.equal(sourceWorkerPlan({}).keyId, 'CONVEX');
  assert.throws(
    () => sourceWorkerPlan({ FORGE_SOURCE_PROVIDER: 'modal' }),
    e => e.code === 'SOURCE_PROVIDER_CHANGED',
  );
});
test('ten-file save has one execution, atomic progress, lost-reply recovery and zero idle schedules', async t => {
  const s = await fixture();
  try {
    assert.equal(s.scheduled.length, 0, 'no job means no scheduled source function');
    await s.submit();
    const dispatch = s.scheduled.shift();
    assert.equal(dispatch.name, 'projectConvexSource:dispatch');
    s.failures.add('projectConvexSourceStore:dispatch');
    await assert.rejects(
      s.execute(dispatch),
      /lost reply/,
      'lost dispatch reply retains the reserved execution',
    );
    assert.equal(s.tables.projectSourceSteps.size, 1);
    assert.equal(s.scheduled.length, 1);
    const job = await s.load();
    assert.equal(job.control.provider, 'convex');
    const request = {
      projectId: s.projectId,
      jobId: job.id,
      input: JSON.stringify(sourceDispatch(s.projectId, job)),
    };
    await s.call('retryStart', store.start, request);
    assert.equal(s.scheduled.length, 1, 'retry start never schedules a second execution');
    const step = s.scheduled.shift();
    s.failures.add('projectConvexSourceStore:commit');
    await assert.rejects(s.execute(step), /lost reply/);
    const completed = await s.load();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.executionId, job.executionId);
    const size = s.scheduled.length;
    await s.execute(step);
    assert.equal(s.scheduled.length, size, 'lost commit replay is a no-op');
    assert.equal(s.scheduled[0].name, 'projectHostedSaveJobs:complete');
    const calls = s.invocations.filter(n => !['retryStart'].includes(n)).length;
    // Include source storage accesses in addition to every explicit function.
    const count = s.countsIO();
    assert(calls + count.stores + count.gets <= 30, `retry calls=${calls}, storage=${JSON.stringify(count)}`);
    s.scheduled.length = 0;
    await s.execute(dispatch);
    assert.equal(s.scheduled.length, 0, 'terminal/idle dispatch schedules nothing');
    t.diagnostic(
      JSON.stringify({
        calls,
        storage: count,
        total: calls + count.stores + count.gets,
        executions: s.tables.projectSourceSteps.size,
      }),
    );
  } finally {
    s.restore();
  }
});
test('epoch and fence changes after a step begins prevent output publication and successor scheduling', async () => {
  for (const mode of ['epoch', 'fence']) {
    const s = await fixture();
    try {
      await s.submit();
      await s.execute(s.scheduled.shift());
      const task = s.scheduled.shift(),
        job = await s.load();
      const started = JSON.parse(await s.call('beginStep', store.begin, task.args));
      assert(started);
      if (mode === 'epoch')
        s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
      else
        await s.run(
          'cancel',
          ctx => jobs.cancelSourceJob(ctx, { projectId: s.projectId, jobId: job.id, actor: 'owner' }),
          {},
        );
      const input = {
        ...task.args,
        cursor: null,
        objects: [],
        output: { sha256: 'a'.repeat(64), size: 1 },
        failure: null,
      };
      if (mode === 'epoch')
        await assert.rejects(
          s.call('staleCommit', store.commit, input),
          e => e.data?.code === 'SOURCE_AUTHORITY_CHANGED',
        );
      else await s.call('staleCommit', store.commit, input);
      assert.equal(s.scheduled.length, 0);
      assert.notEqual((await s.load()).status, 'completed');
    } finally {
      s.restore();
    }
  }
});

test('normal 10-file save stays within the end-to-end call budget', async t => {
  const s = await fixture();
  try {
    await s.submit();
    await s.execute(s.scheduled.shift());
    await s.execute(s.scheduled.shift());
    const job = await s.load();
    await s.call('resultDownloadConvex', saveJobs.resultDownload, { projectId: s.projectId, jobId: job.id });
    const row = [...s.tables.projectObjects.values()].find(r => r.digest === job.output.sha256);
    const manifest = (await storedBytes(s, row)).toString();
    await s.call('publishConvex', saveJobs.publish, {
      projectId: s.projectId,
      jobId: job.id,
      result: manifest,
    });
    const io = s.countsIO(),
      setup = s.counts.filter(c => ['prepare', 'stage', 'progress'].includes(c.name)).length;
    const calls = s.invocations.length + setup + 1; // complete action itself; result body read above.
    assert(
      calls + io.stores + io.gets <= 30,
      JSON.stringify({ calls, io, setup, invocations: s.invocations }),
    );
    t.diagnostic(JSON.stringify({ calls, storage: io, total: calls + io.stores + io.gets }));
  } finally {
    s.restore();
  }
});

test('reservation and first schedule roll back together; failed action resumes the same cursor only on an explicit trigger', async () => {
  const s = await fixture();
  try {
    await s.submit();
    const dispatch = s.scheduled.shift();
    s.hooks.failInsert = true;
    await assert.rejects(s.execute(dispatch), /schedule transaction failure/);
    let job = await s.load();
    assert.equal(job.executionId, null);
    assert.equal(job.control.providerReservation, undefined);
    assert.equal(s.scheduled.length, 0);
    s.hooks.failInsert = false;
    await s.execute(dispatch);
    const task = s.scheduled.shift();
    job = await s.load();
    s.hooks.scheduled = 'failed';
    const request = {
      projectId: s.projectId,
      jobId: job.id,
      input: JSON.stringify(sourceDispatch(s.projectId, job)),
    };
    await s.execute(dispatch);
    assert.equal(s.scheduled.length, 1);
    assert.equal(s.scheduled[0].args.step, task.args.step);
    await s.call('lookupRetry', store.lookup, request);
    assert.equal(s.scheduled.length, 1);
    assert.equal((await s.load()).executionId, job.executionId);
  } finally {
    s.restore();
  }
});

test('the storage fake rejects a Blob without a content type, like Convex in the Node runtime', async () => {
  await assert.rejects(convexStoreBlob(new Blob([Buffer.from('x')])), /BadHeader/);
  const typed = new Blob([Buffer.from('x')], { type: 'application/octet-stream' });
  assert.equal((await convexStoreBlob(typed, { sha256: digest(Buffer.from('x')) })).toString(), 'x');
  await assert.rejects(convexStoreBlob(typed, { sha256: 'a'.repeat(64) }), /sha256/);
});
test('a step that failed on a platform error is retried after the 60 s lease expired and completes under the same execution', async () => {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  const s = await fixture();
  try {
    await s.submit();
    const dispatch = s.scheduled.shift();
    await s.execute(dispatch);
    const step = s.scheduled.shift(),
      job = await s.load();
    s.hooks.failStore = true;
    await assert.rejects(s.execute(step), /synthetic platform failure/);
    offset += 61000;
    assert(job.control.workerUntil <= Date.now(), 'the dead execution expired');
    await assert.rejects(
      s.call('expiredBegin', store.begin, step.args),
      e => e.data?.code === 'SOURCE_JOB_FENCED',
      'nothing from the dead attempt can run before an explicit recovery',
    );
    // A stale step number neither commits nor extends the lease.
    await s.call('staleCommit', store.commit, {
      ...step.args,
      step: step.args.step + 7,
      cursor: null,
      objects: [],
      output: null,
      failure: null,
    });
    assert.equal((await s.load()).version, job.version);
    // The lead replays the finish: submit schedules the controller, whose lookup
    // sees the failed step action and resumes it under the same execution.
    await s.submit();
    s.hooks.scheduled = 'failed';
    await s.execute(s.scheduled.shift());
    const renewed = await s.load();
    assert.equal(renewed.executionId, job.executionId);
    assert.equal(renewed.attempt, job.attempt);
    assert.equal(renewed.fence, job.fence);
    assert(renewed.control.workerUntil > Date.now(), 'recovery renewed the lease');
    assert.equal(s.scheduled.length, 1);
    assert.deepEqual(s.scheduled[0].args, step.args, 'the same step resumes');
    // A second trigger while that step is pending schedules nothing more.
    await s.submit();
    await s.execute(s.scheduled.pop());
    assert.equal(s.scheduled.length, 1, 'recovery happens once');
    await s.execute(s.scheduled.shift());
    const done = await s.load();
    assert.equal(done.status, 'completed');
    assert.equal(done.executionId, job.executionId);
    assert.equal(s.tables.projectSourceSteps.size, 1, 'one execution');
    assert.equal(s.scheduled[0].name, 'projectHostedSaveJobs:complete');
  } finally {
    Date.now = real;
    s.restore();
  }
});

test('a thrown worker failure is public and replayable before and after lease expiry, without another execution', async () => {
  const s = await fixture();
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await s.submit();
    await s.execute(s.scheduled.shift());
    const step = s.scheduled.shift();
    const job = await s.load();
    s.hooks.failStore = true;
    await assert.rejects(s.execute(step), /synthetic platform failure/);
    const args = {
      projectId: s.projectId,
      operationId: [...s.tables.projectHostedSaves.values()][0].operationId,
    };
    s.hooks.scheduled = 'failed';
    const failed = JSON.parse(await s.call('failedProgress', saveApi.progress, args));
    assert.equal(failed.status, 'retryable');
    assert.equal(failed.error.code, 'SOURCE_WORKER_STEP_FAILED');
    assert.equal(failed.failedPhase, `source-step:${step.args.step}`);
    assert.equal(failed.jobId, job.id);
    assert.equal(s.scheduled.length, 0, 'observation never schedules recovery');
    offset += 61000;
    const expired = JSON.parse(await s.call('expiredProgress', saveApi.progress, args));
    assert.equal(expired.status, 'retryable');
    assert.equal(expired.error.code, 'SOURCE_JOB_STALLED');
    assert.equal(expired.failedPhase, failed.failedPhase);
    const replay = JSON.parse(await s.submit());
    assert.equal(replay.status, 'retryable', 'same-operation replay returns the stalled state immediately');
    assert.equal(replay.jobId, job.id);
    s.hooks.scheduled = 'failed';
    await s.execute(s.scheduled.shift());
    await s.execute(s.scheduled.shift());
    assert.equal((await s.load()).status, 'completed');
    assert.equal((await s.load()).executionId, job.executionId);
    assert.equal(s.tables.projectSourceSteps.size, 1);
  } finally {
    Date.now = real;
    s.restore();
  }
});

test('an expired pending step is renewed in place by explicit replay, without duplicate scheduling', async () => {
  const s = await fixture();
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await s.submit();
    await s.execute(s.scheduled.shift());
    const step = s.scheduled.shift();
    const job = await s.load();
    offset += 61000;
    const replay = JSON.parse(await s.submit());
    assert.equal(replay.error.code, 'SOURCE_JOB_STALLED');
    await s.execute(s.scheduled.shift());
    assert.equal(s.scheduled.length, 0, 'the pending scheduler delivery already owns this step');
    await s.execute(step);
    assert.equal((await s.load()).status, 'completed');
    assert.equal((await s.load()).executionId, job.executionId);
  } finally {
    Date.now = real;
    s.restore();
  }
});

test('lost publication delivery becomes retryable instead of staying submitted forever', async () => {
  const s = await fixture();
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await s.submit();
    await s.execute(s.scheduled.shift());
    await s.execute(s.scheduled.shift());
    const job = await s.load();
    offset += 61000;
    const args = {
      projectId: s.projectId,
      operationId: [...s.tables.projectHostedSaves.values()][0].operationId,
    };
    const progress = JSON.parse(await s.call('lostDeliveryProgress', saveApi.progress, args));
    assert.equal(progress.status, 'retryable');
    assert.equal(progress.error.code, 'SOURCE_PUBLICATION_STALLED');
    assert.equal(progress.failedPhase, 'source-publication');
    const replay = JSON.parse(await s.submit());
    assert.equal(replay.status, 'retryable');
    assert.equal(replay.jobId, job.id);
    assert.equal(
      (await s.load()).version,
      job.version,
      'observation and submit never repeat output publication',
    );
  } finally {
    Date.now = real;
    s.restore();
  }
});

test('a failed fanout task is public before its parent join runs or its lease expires', async () => {
  const s = await fixture();
  try {
    await s.submit();
    await s.execute(s.scheduled.shift());
    const step = [...s.tables.projectSourceSteps.values()][0];
    const batchId = s.insert('projectSourceBatches', {
      projectId: s.projectId,
      jobId: step.jobId,
      step: step.step,
      kind: 'verify',
      end: 1,
      total: 1,
      next: 1,
      completed: 1,
      status: 'done',
      failure: 'SOURCE_HASH_MISMATCH',
    });
    s.patch('projectSourceSteps', step._id, { batchId });
    const args = {
      projectId: s.projectId,
      operationId: [...s.tables.projectHostedSaves.values()][0].operationId,
    };
    const observed = JSON.parse(await s.call('fanoutFailureProgress', saveApi.progress, args));
    assert.equal(observed.status, 'retryable');
    assert.equal(observed.error.code, 'SOURCE_HASH_MISMATCH');
    assert.equal(observed.failedPhase, `source-step:${step.step}`);
    assert((await s.load()).control.workerUntil > Date.now());
  } finally {
    s.restore();
  }
});
