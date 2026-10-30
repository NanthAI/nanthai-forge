// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { progressFixture } from './projectWorkIndex-progress-fixture.mjs';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';
import { hostProgress, formatHostProgress } from '../dist/host-progress.js';
const { pending, pendingResumeLimit } = await import(moduleUrl('../convex/projectWorkIndexBuildFailure.ts'));
const { buildLookups } = await import(moduleUrl('../convex/projectWorkIndexBuildLookup.ts'));
const { rawContent } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const { indexReadContext } = await import(moduleUrl('../convex/projectWorkIndexRetry.ts'));
const buildStates = await import(moduleUrl('../convex/projectWorkIndexBuildStates.ts'));
const buildDiffstats = await import(moduleUrl('../convex/projectWorkIndexBuildDiffstats.ts'));
const { buildProgress } = await import(moduleUrl('../convex/projectWorkIndexBuildProgress.ts'));
const generation = f => [...f.s.tables.projectWorkGenerations.values()][0];
const complete = async f => {
  let result;
  do {
    result = await f.drive();
  } while (typeof result !== 'string');
  return result;
};
function injectSummary(f, error, failures = Infinity) {
  const get = f.s.ctx.storage.get;
  let calls = 0,
    target;
  f.s.ctx.storage.get = async id => {
    const cursor = generation(f)?.ensureCursor;
    const selected = cursor && JSON.parse(cursor);
    if (!target && selected?.phase === 'summaries' && selected.field === 1) target = id;
    if (id === target && calls++ < failures) throw error;
    return get(id);
  };
  return {
    get calls() {
      return calls;
    },
    get target() {
      return target;
    },
  };
}

test('summaries retry ECONNRESET in-place with no extra successful RPCs', async t => {
  // Hold the action wall clock steady so unrelated scheduler pauses cannot add
  // continuation/catalog calls to just one side of this read-cost comparison.
  t.mock.method(Date, 'now', () => 1_000_000);
  const baseline = progressFixture(0.02, undefined, undefined, { treeFiles: 40 });
  const saved = baseline.snapshot();
  await complete(baseline);
  const f = progressFixture(0.02, saved, undefined, { treeFiles: 40 });
  const fault = injectSummary(
    f,
    Object.assign(new Error('storage get url ECONNRESET'), { code: 'ECONNRESET' }),
    1,
  );
  await complete(f);
  assert(fault.calls >= 2);
  assert.deepEqual(f.metrics.calls, baseline.metrics.calls, 'storage retry adds no Convex calls');
  assert.equal(f.s.scheduled.length, baseline.s.scheduled.length);
  t.diagnostic(JSON.stringify({ targetAttempts: fault.calls, calls: f.metrics.calls }));
});

test('typed summary failures retain their code and are never retried', async () => {
  const f = progressFixture(0.02);
  const fault = injectSummary(f, new ForgeError('INVALID_WORK_BACKUP', 'ECONNRESET in invalid source'));
  await assert.rejects(
    complete(f),
    error => error.code === 'INVALID_WORK_BACKUP' || error.data?.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(fault.calls, 1);
  assert.equal(generation(f).ensureRetry, undefined);
});

test('permanent summary fault retains progress, fails after five resumes, and names its pin', async () => {
  const f = progressFixture(0.02);
  const fault = injectSummary(
    f,
    Object.assign(new Error('storage get url ECONNRESET'), { code: 'ECONNRESET' }),
  );
  let result;
  do {
    result = await f.drive();
  } while (!JSON.parse(result.progress ?? '{}').retryable);
  const cursor = generation(f).ensureCursor;
  const progress = JSON.parse(result.progress);
  assert.equal(progress.buildPhase, 'summaries');
  assert.equal(progress.field, 'views');
  assert.equal(progress.total, f.data.views.length);
  assert(progress.total > 0, 'retry progress reads its durable cursor');
  for (let resume = 1; resume < pendingResumeLimit; resume++) {
    result = await f.drive();
    assert.equal(result.pending, true);
    assert.equal(generation(f).ensureCursor, cursor);
  }
  await assert.rejects(f.drive(), error => {
    assert.equal(error.data.code, 'WORK_INDEX_READ_FAILED');
    assert.equal(error.data.pin.sha256, fault.target);
    assert.match(error.data.message, new RegExp(fault.target));
    return true;
  });
  assert.equal(fault.calls, 3 * (pendingResumeLimit + 1));
  assert.equal(generation(f).status, 'failed');
  const calls = fault.calls;
  await assert.rejects(f.drive(), error => error.data.code === 'WORK_INDEX_READ_FAILED');
  assert.equal(fault.calls, calls, 'failed generation never retries its item');
  assert.equal(f.s.scheduled.length, 0);
});

test('internal compatibility reads never start a full build when the index is absent', async () => {
  const { ensureInternal } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const f = progressFixture(0.02, undefined, (ctx, { projectId }) =>
    ensureInternal._handler(ctx, { projectId, owner: 'owner' }),
  );
  const fault = injectSummary(f, new Error('ECONNRESET'));
  await assert.rejects(f.drive(), error => error.code === 'PROJECT_WORK_INDEX_MISSING');
  assert.equal(fault.calls, 0);
  assert.equal(f.s.tables.projectWorkGenerations.size, 0);
  assert.equal(f.s.scheduled.length, 0);
});

test('failure operations reconcile and a moved cursor cannot be failed by an old reader', async () => {
  const f = progressFixture(0.02);
  await f.drive();
  const g = generation(f);
  const args = {
    projectId: 'project',
    owner: 'owner',
    generationId: g._id,
    expected: g.ensureCursor,
    expectedBatch: g.nextBatch,
    operationId: 'one',
  };
  const once = await pending._handler(f.s.ctx, args);
  assert.deepEqual(await pending._handler(f.s.ctx, args), once);
  const twice = await pending._handler(f.s.ctx, { ...args, operationId: 'two' });
  assert.deepEqual(
    await pending._handler(f.s.ctx, args),
    twice,
    'old lost replies reconcile after another resume',
  );
  await f.s.ctx.runMutation(makeFunctionReference('projectWorkIndexBuildStore:step'), {
    projectId: 'project',
    owner: 'owner',
    generationId: g._id,
    expected: args.expected,
    cursor: args.expected,
    entries: [],
  });
  const advanced = structuredClone(generation(f));
  assert.equal(advanced.ensureRetry, undefined);
  assert.deepEqual(
    await pending._handler(f.s.ctx, args),
    advanced,
    'old reads cannot fail a later batch at the same cursor',
  );
  await f.drive();
  const current = structuredClone(generation(f));
  assert.equal(current.ensureRetry, undefined, 'successful work clears the failure streak');
  assert.deepEqual(await pending._handler(f.s.ctx, { ...args, operationId: 'late' }), current);
});

test('failure writes retain current authority and cannot target another project or snapshot', async () => {
  const f = progressFixture(0.02);
  await f.drive();
  const g = generation(f);
  const args = {
    projectId: 'project',
    owner: 'stranger',
    generationId: g._id,
    expected: g.ensureCursor,
    expectedBatch: g.nextBatch,
    operationId: 'denied',
  };
  await assert.rejects(
    pending._handler(f.s.ctx, args),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(generation(f).ensureRetry, undefined);
  f.s.tables.hostedProjects.set('other', { _id: 'other', owner: 'owner' });
  await assert.rejects(
    pending._handler(f.s.ctx, { ...args, projectId: 'other', owner: 'owner' }),
    error => error.code === 'WORK_STALE',
  );
  f.s.tables.hostedProjects.get('project').work.revision++;
  assert.equal(await pending._handler(f.s.ctx, { ...args, owner: 'owner' }), null);
  assert.equal(generation(f).ensureRetry, undefined);
});

test('lookup reads retry but typed access errors do not', async () => {
  let calls = 0;
  const ctx = {
    storage: {},
    runQuery: async () => {
      if (++calls < 3) throw new Error('query ECONNRESET');
      return [null];
    },
  };
  assert.deepEqual(await buildLookups(ctx, {}, [{ collection: 'views', key: 'one' }]), [null]);
  assert.equal(calls, 3);
  calls = 0;
  ctx.runQuery = async () => {
    calls++;
    throw new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'ECONNRESET' });
  };
  await assert.rejects(buildLookups(ctx, {}, [{ collection: 'views', key: 'one' }]));
  assert.equal(calls, 1);
});

test('raw object failures name the exact pin and nested read actions stay at three attempts', async () => {
  let calls = 0;
  const pin = { sha256: 'a'.repeat(64), size: 4 };
  const child = indexReadContext({
    storage: {
      get: async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
    },
  });
  const parent = indexReadContext({
    storage: {},
    runAction: () => rawContent(child, { storageId: 'storage' }, pin),
  });
  await assert.rejects(parent.runAction('child', {}), e => e.data.pin.sha256 === pin.sha256);
  assert.equal(calls, 3);
});

test('diffstat and State child actions retry the same read rather than repeating mutations', async () => {
  const f = progressFixture(0.02, undefined, undefined, { treeFiles: 40 });
  const get = f.s.ctx.storage.get;
  const target = f.filePins[0].sha256;
  let calls = 0;
  f.s.ctx.storage.get = async id => {
    if (id === target && ++calls === 1) throw new Error('ECONNRESET');
    return get(id);
  };
  await buildDiffstats.compare._handler(f.s.ctx, {
    projectId: 'project',
    actor: 'owner',
    files: [{ before: f.filePins[0], after: f.filePins[1] }],
  });
  assert.equal(calls, 2);
  const treePin = f.sourcePins[0];
  calls = 0;
  f.s.ctx.storage.get = async id => {
    if (id === treePin.sha256 && ++calls === 1) throw new Error('ECONNRESET');
    return get(id);
  };
  await buildStates.tree._handler(f.s.ctx, { projectId: 'project', actor: 'owner', pin: treePin });
  assert.equal(calls, 2);
});

test('heavy View output exposes discovered file totals and a files-based resume-relative ETA', async () => {
  const cursor = {
    phase: 'summaries',
    field: 1,
    record: 1,
    source: 0,
    filesTotal: 1000,
    output: {
      key: 'page',
      part: 1,
      parts: 10,
      after: { phase: 'summaries', field: 1, record: 2, source: 0, filesTotal: 11000 },
    },
  };
  const g = {
    ensureCursor: JSON.stringify(cursor),
    metadata: JSON.stringify({ counts: { views: 100, viewFiles: 1000 } }),
    nextBatch: 10,
  };
  const events = [],
    progress = hostProgress(event => events.push(event));
  progress.phase('building Work index');
  progress.index(buildProgress(g));
  assert.equal(events.at(-1).etaSeconds, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  g.nextBatch++;
  g.metadata = JSON.stringify({ counts: { views: 100, viewFiles: 2000 } });
  progress.index(buildProgress(g));
  const event = events.at(-1);
  assert.equal(event.indexBuild.done, 1, 'one heavy View is still staging');
  assert.equal(event.indexBuild.filesTotal, 11000);
  assert(event.indexBuild.filesPerMinute > 0);
  assert(
    event.etaSeconds > 0 && event.etaSeconds < 5,
    'file throughput advances ETA even with unchanged Views',
  );
  assert.match(formatHostProgress(event), /2000\/11000 changed files discovered.*files\/min.*ETA \d+s/);
});

test('R2 index reads share the three-attempt budget for HTTP and connection faults', async t => {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const saved = names.map(name => process.env[name]);
  names.forEach(name => {
    process.env[name] = 'synthetic';
  });
  t.after(() =>
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }),
  );
  const bytes = Buffer.from('synthetic source');
  const pin = { sha256: digest(bytes), size: bytes.length };
  const row = { location: 'r2', r2Committed: true, r2Key: 'synthetic/object' };
  const ctx = indexReadContext({ storage: {} });
  let calls = 0,
    mode = 'recover';
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'connection') throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    if (mode === 'missing') return new Response('', { status: 404 });
    if (mode === 'permanent' || calls === 1) return new Response('', { status: 503 });
    return new Response(bytes);
  });
  assert.deepEqual(await rawContent(ctx, row, pin), bytes);
  assert.equal(calls, 2);
  for (mode of ['permanent', 'connection']) {
    calls = 0;
    await assert.rejects(
      rawContent(ctx, row, pin),
      error => error.data?.code === 'WORK_INDEX_RETRY' && error.data.pin.sha256 === pin.sha256,
    );
    assert.equal(calls, 3);
  }
  calls = 0;
  mode = 'missing';
  await assert.rejects(rawContent(ctx, row, pin), error => error.code === 'R2_OBJECT_UNAVAILABLE');
  assert.equal(calls, 1, 'typed missing-object errors never retry');
});
