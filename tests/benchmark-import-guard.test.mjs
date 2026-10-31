// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { ImportBenchmarkMonitor } from '../scripts/benchmark-import-monitor.mjs';
import { importBenchmarkGuard, benchmarkLogStream } from '../scripts/benchmark-import-guard.mjs';
import { settleR2Purge } from './default-r2.mjs';
const benchmark = await import(moduleUrl('../convex/projectBenchmark.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const imports = await import(moduleUrl('../convex/projectGithubImportStore.ts'));
const trace = await import(moduleUrl('../convex/projectExecution.ts'));
const target = { projectId: 'project', name: 'Synthetic import benchmark' };
const marker = (projectId = 'project') =>
  `FORGE_PROJECT_EXECUTION ${JSON.stringify({ projectId, name: target.name })}`;
const event = (id, at, error = null, tagged = true) => ({
  kind: 'Completion',
  requestId: `request-${id}`,
  executionId: `execution-${id}`,
  timestamp: at / 1000,
  executionTimestamp: at / 1000,
  error,
  cachedResult: false,
  identifier: 'projectGithubImportWorker:run',
  logLines: tagged ? [{ messages: [marker()] }] : [],
  usageStats: { databaseReadDocuments: 2, databaseWriteDocuments: 1 },
});

test('rate means three consecutive completed minutes above 300, failures count and gaps reset', () => {
  let now = 0;
  const monitor = new ImportBenchmarkMonitor({ ...target, since: 0, now: () => now });
  for (const minute of [0, 1, 3, 4, 5]) {
    for (let i = 0; i < 301; i++) monitor.observe(event(`${minute}-${i}`, minute * 60_000 + i, 'failed'));
    now = (minute + 1) * 60_000;
    monitor.advance(now);
    assert.equal(monitor.reason, minute === 5 ? 'rate' : null);
  }
  assert.equal(monitor.failures, 1505);
  const boundary = new ImportBenchmarkMonitor({ ...target, since: 0 });
  for (let i = 0; i < 900; i++) boundary.observe(event(i, Math.floor(i / 300) * 60_000));
  boundary.advance(180_000);
  assert.equal(boundary.reason, null, 'exactly 300/min is permitted');
});

test('request-tree attribution includes early child failures, retry attempts, and excludes shared/replay events and includes cached invocations', () => {
  const monitor = new ImportBenchmarkMonitor({ ...target, since: 10 });
  const child = { ...event('child', 100, 'failure', false), requestId: 'parent' };
  monitor.observe(child);
  monitor.observe({ ...event('foreign', 110), logLines: [marker('other-project')] });
  monitor.observe({
    ...event('cached', 120),
    cachedResult: true,
    usageStats: { databaseReadDocuments: 0, databaseWriteDocuments: 0 },
  });
  monitor.observe({ ...event('old', 1) });
  const parent = { ...event('parent', 130), requestId: 'parent' };
  monitor.observe(parent);
  monitor.observe(child);
  monitor.observe(parent);
  monitor.observe({ ...parent, occInfo: { retryCount: 1 }, error: 'OCC retry' });
  assert.equal(monitor.total, 4);
  assert.equal(monitor.failures, 2);
  assert.deepEqual(monitor.usage, { databaseReadDocuments: 6, databaseWriteDocuments: 3 });
  monitor.deleted(200);
  assert.equal(monitor.quiet(300_199), false);
  assert.equal(monitor.quiet(300_200), true);
  monitor.observe(event('late', 300_100, 'failed'));
  assert.equal(monitor.quiet(300_200), false, 'late failure resets proof window');
  assert.equal(monitor.postDelete, 1);
});

function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'benchmark',
    name: target.name,
    currentBackup: null,
    revision: 0,
  });
  const stored = {
    _id: 'job',
    _creationTime: 1,
    protocol: 2,
    owner: 'owner',
    projectId: 'project',
    operationId: 'import',
    request: 'request',
    repository: 'fixture/runaway',
    commit: 'a'.repeat(40),
    at: 'synthetic',
    visibility: 'private',
    step: 0,
    cursor: '{}',
    phase: 'importing',
    totalKnown: true,
    completed: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
  };
  s.tables.projectGithubImports.set('job', stored);
  const originalSystemQuery = s.ctx.db.system.query;
  let pageReads = 0,
    maxPage = 0,
    activeParent;
  s.ctx.db.system.query = table => {
    if (table !== '_scheduled_functions') return originalSystemQuery(table);
    let lower = 0;
    return {
      withIndex(name, build) {
        assert.equal(name, 'by_creation_time');
        build({
          gte(field, value) {
            assert.equal(field, '_creationTime');
            lower = value;
          },
        });
        return {
          async paginate({ cursor, numItems }) {
            assert.equal(numItems, 10);
            const rows = s.scheduled
              .map((entry, i) => ({
                _id: entry.id,
                _creationTime: i + 1,
                name: getFunctionName(entry.fn).replace(':', '.js:'),
                args: [entry.args],
                ...s.tasks.get(entry.id),
              }))
              .filter(row => row._creationTime >= lower);
            const offset = Number(cursor ?? 0),
              page = rows.slice(offset, offset + numItems);
            pageReads += page.length;
            maxPage = Math.max(maxPage, page.length);
            return {
              page,
              isDone: offset + numItems >= rows.length,
              continueCursor: String(offset + page.length),
            };
          },
        };
      },
    };
  };
  const schedule = s.ctx.scheduler.runAfter;
  s.ctx.scheduler = {
    ...s.ctx.scheduler,
    runAfter: async (time, fn, args) => {
      const id = await schedule(time, fn, args);
      // Model the provider's cancellation of descendants of an in-progress action.
      if (activeParent && s.tasks.get(activeParent)?.state.kind === 'canceled')
        await s.ctx.scheduler.cancel(id);
      return id;
    },
  };
  const admin = {
    query: (ref, args) => benchmark[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
    mutation: (ref, args) => benchmark[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
  };
  const owner = {
    mutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectLifecycle:permanentlyDelete');
      const parent = activeParent;
      activeParent = undefined;
      try {
        return await lifecycle.permanentlyDelete._handler(s.ctx, args);
      } finally {
        activeParent = parent;
      }
    },
  };
  return {
    ...s,
    admin,
    owner,
    setActive: id => {
      activeParent = id;
    },
    stats: () => ({ pageReads, maxPage }),
  };
}

test('synthetic runaway reaches 5000 including failures, cancels running/pending identities, deletes, then executes zero jobs', async t => {
  const s = fixture();
  let now = 1,
    stopped = 0,
    executions = 0;
  const guard = importBenchmarkGuard({
    ...target,
    since: 0,
    now: () => now,
    admin: s.admin,
    owner: s.owner,
    stopWorkload: async () => {
      stopped++;
    },
  });
  const fn = makeFunctionReference('projectGithubImportWorker:run');
  let current = await s.ctx.scheduler.runAfter(0, fn, { id: 'job', actor: 'owner' });
  for (let step = 0; step < 1000; step++) {
    s.setActive(current);
    s.tasks.set(current, { state: { kind: 'inProgress' } });
    // Five actual observed executions per synthetic page, not a source-file loop.
    for (let call = 0; call < 5; call++) {
      executions++;
      guard.observe(event(executions, now++, call === 0 ? 'transient failure' : null));
    }
    if (guard.monitor.reason) await guard.tick();
    if (s.tables.hostedProjects.get('project').removal === 'deleting') break;
    await imports.advance._handler(s.ctx, {
      id: 'job',
      actor: 'owner',
      step,
      cursor: '{}',
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      discovering: false,
    });
    s.tasks.set(current, { state: { kind: 'success' } });
    current = s.tables.projectGithubImports.get('job').task;
  }
  assert.equal(executions, 5000);
  assert.equal(guard.monitor.reason, 'total');
  assert.equal(guard.monitor.failures, 1000);
  assert.equal(stopped, 1);
  assert.equal(s.tasks.get(current).state.kind, 'canceled');
  // A currently running action can finish, but its future scheduling is canceled.
  const late = await s.ctx.scheduler.runAfter(0, fn, { id: 'job', actor: 'owner' });
  assert.equal(s.tasks.get(late).state.kind, 'canceled');
  s.setActive(undefined);
  await assert.rejects(
    imports.advance._handler(s.ctx, {
      id: 'job',
      actor: 'owner',
      step: 999,
      cursor: '{}',
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      discovering: false,
    }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  for (let page = 0; s.tables.hostedProjects.get('project').removal !== 'deleted'; page++) {
    assert(page < 100, 'ordinary deletion converges');
    const task = s.scheduled.find(
      entry =>
        ['projectLifecycle:purge', 'projectR2Maintenance:purgeDeletedProjectPage'].includes(
          getFunctionName(entry.fn),
        ) && s.tasks.get(entry.id).state.kind === 'pending',
    );
    assert(task, 'deletion retains its scheduled continuation');
    settleR2Purge(s.tables.hostedProjects.get('project'));
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
    s.tasks.set(task.id, { state: { kind: 'success' } });
  }
  assert.equal(await guard.confirmDeleted(), true);
  const calls = structuredClone(guard.receipts);
  now += 300_000;
  await guard.tick();
  assert.deepEqual(guard.receipts, calls, 'quiet window makes zero function calls');
  assert.equal(guard.monitor.quiet(), true);
  assert.equal(guard.monitor.postDelete, 0);
  assert.equal(
    [...s.scheduled].filter(
      entry =>
        getFunctionName(entry.fn) === 'projectGithubImportWorker:run' &&
        s.tasks.get(entry.id).state.kind === 'pending',
    ).length,
    0,
  );
  assert.equal(s.tables.projectGithubImports.size, 0);
  assert.equal(
    [...s.tasks.values()].filter(task => ['pending', 'inProgress'].includes(task.state.kind)).length,
    0,
  );
  assert(
    Buffer.byteLength(JSON.stringify([...guard.monitor.requests])) +
      Buffer.byteLength(JSON.stringify([...guard.monitor.seen])) <
      2 * 1024 * 1024,
  );
  assert(s.stats().maxPage <= 10);
  assert.equal(guard.receipts.cancellationCalls, 100);
  t.diagnostic(
    JSON.stringify({
      executions,
      failures: guard.monitor.failures,
      ...guard.receipts,
      ...s.stats(),
      retainedBytes: Buffer.byteLength(JSON.stringify([...guard.monitor.requests])),
    }),
  );
});

test('bounded cancellation scopes import and index identities; other projects/deletion remain runnable and retries are harmless', async () => {
  const s = fixture();
  s.tables.projectWorkGenerations.set('generation', { _id: 'generation', projectId: 'project' });
  s.tables.projectGithubImports.set('foreign', { _id: 'foreign', projectId: 'other-project' });
  for (let i = 0; i < 1500; i++)
    await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectWorkIndexStore:retire'), {
      generationId: 'generation',
    });
  const foreign = await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectGithubImportWorker:run'), {
    id: 'foreign',
    actor: 'other',
  });
  const deletion = await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectLifecycle:purge'), {
    projectId: 'project',
  });
  let cursor = null,
    canceled = 0;
  do {
    const page = await benchmark.cancelScheduled._handler(s.ctx, {
      ...target,
      operationId: 'cancel',
      cursor,
    });
    canceled += page.canceled;
    if (page.isDone) break;
    cursor = page.cursor;
  } while (true);
  assert.equal(canceled, 1500);
  assert.equal(s.tasks.get(foreign).state.kind, 'pending');
  assert.equal(s.tasks.get(deletion).state.kind, 'pending');
  assert.equal(
    (
      await benchmark.cancelScheduled._handler(s.ctx, {
        ...target,
        operationId: 'cancel',
        cursor: null,
      })
    ).canceled,
    0,
  );
  await assert.rejects(
    benchmark.cancelScheduled._handler(s.ctx, {
      ...target,
      name: 'wrong',
      operationId: 'cancel',
      cursor: null,
    }),
    e => e.code === 'BENCHMARK_PROJECT_CHANGED',
  );
  assert.equal(benchmark.cancelScheduled.isInternal, true);
});

test('unknown deletion reply replays the same operation and revision, and blocked deletion cannot pass quiet proof', async () => {
  const s = fixture(),
    requests = [],
    journal = {};
  let lose = true;
  const owner = {
    mutation: async (ref, args) => {
      requests.push(structuredClone(args));
      await s.owner.mutation(ref, args);
      if (lose) {
        lose = false;
        throw Error('reply lost');
      }
    },
  };
  let guard = importBenchmarkGuard({ ...target, since: 0, admin: s.admin, owner, journal });
  await assert.rejects(guard.stop(), /reply lost/);
  guard = importBenchmarkGuard({ ...target, admin: s.admin, owner, journal });
  await guard.stop();
  assert.deepEqual(requests[0], requests[1]);
  s.tables.hostedProjects.get('project').purgeBlocked = 'R2_MAINTENANCE_DISABLED';
  await assert.rejects(guard.confirmDeleted(), /R2_MAINTENANCE_DISABLED/);
  assert.equal(guard.monitor.quiet(), false);
});

test('project attribution contains no source bytes and emits once per invocation/project', () => {
  const ctx = {},
    lines = [],
    previous = console.log;
  console.log = text => lines.push(text);
  try {
    trace.projectExecution(ctx, 'project', target.name);
    trace.projectExecution(ctx, 'project', target.name);
  } finally {
    console.log = previous;
  }
  assert.deepEqual(lines, [marker()]);
});

test('provider stream begins at current cursor, counts failure JSONL, and surfaces transport loss', async () => {
  const controller = new AbortController(),
    seen = [],
    cursors = [];
  const source = await benchmarkLogStream({
    url: 'https://synthetic.invalid',
    adminKey: 'synthetic-secret',
    signal: controller.signal,
    onEvent: e => seen.push(e),
    fetchImpl: async (url, init) => {
      cursors.push(new URL(url).searchParams.get('cursor'));
      assert.equal(init.headers.Authorization, 'Convex synthetic-secret');
      if (cursors.length === 1) return Response.json({ entries: [event('history', 1)], newCursor: 10 });
      if (cursors.length === 2)
        return Response.json({ entries: [event('failed', 11, 'failure')], newCursor: 20 });
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(source.run(), /BENCHMARK_LOG_UNAVAILABLE/);
  assert.deepEqual(cursors, ['0', '10', '20']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].error, 'failure');
});

test('creation-operation attribution arms before import creates its project and ignores same-name peers', () => {
  const monitor = new ImportBenchmarkMonitor({
    name: target.name,
    creationOperationId: 'our-import',
    since: 0,
  });
  monitor.observe({
    ...event('peer', 1),
    logLines: [
      `FORGE_PROJECT_EXECUTION ${JSON.stringify({ ...target, projectId: 'peer', key: 'other-import' })}`,
    ],
  });
  assert.equal(monitor.target.projectId, undefined);
  monitor.observe({
    ...event('ours', 2),
    logLines: [`FORGE_PROJECT_EXECUTION ${JSON.stringify({ ...target, key: 'our-import' })}`],
  });
  assert.equal(monitor.target.projectId, 'project');
  assert.equal(monitor.total, 1);
});

test('rate breach drives the same cancel-then-owner-delete control path', async () => {
  const s = fixture();
  let now = 0;
  const guard = importBenchmarkGuard({ ...target, since: 0, now: () => now, admin: s.admin, owner: s.owner });
  const task = await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectGithubImportWorker:run'), {
    id: 'job',
    actor: 'owner',
  });
  for (let minute = 0; minute < 3; minute++) {
    for (let i = 0; i < 301; i++) guard.observe(event(`rate-${minute}-${i}`, minute * 60_000 + i));
    now = (minute + 1) * 60_000;
    await guard.tick();
  }
  assert.equal(guard.monitor.reason, 'rate');
  assert.equal(s.tasks.get(task).state.kind, 'canceled');
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
});

test('a definite concurrent publish revision race refreshes deletion pins without retrying an unknown outcome', async () => {
  const s = fixture(),
    requests = [];
  const owner = {
    mutation: async (ref, args) => {
      requests.push(structuredClone(args));
      if (requests.length === 1) s.tables.hostedProjects.get('project').revision++;
      return s.owner.mutation(ref, args);
    },
  };
  const guard = importBenchmarkGuard({ ...target, since: 0, admin: s.admin, owner });
  await guard.stop();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].expectedRevision, 0);
  assert.equal(requests[1].expectedRevision, 1);
  assert.notEqual(requests[0].operationId, requests[1].operationId);
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
});

test('denied project access and deletion log only caller-supplied IDs, never private names or keys', async () => {
  const authority = await import(moduleUrl('../convex/projectAuthority.ts'));
  const s = fixture(),
    lines = [],
    previous = console.log;
  s.caller('intruder');
  console.log = text => lines.push(text);
  try {
    const { readJob } = await import(moduleUrl('../convex/projectGithubImportRead.ts'));
    await assert.rejects(
      readJob({ ...s.ctx }, { id: 'job', actor: 'intruder' }),
      e => e.code === 'PROJECT_UNAVAILABLE',
    );

    await assert.rejects(
      authority.ownedProject(s.ctx, 'project', 'intruder'),
      e => e.code === 'PROJECT_UNAVAILABLE',
    );
    // New invocation context so the metadata test cannot pass through deduplication.
    await assert.rejects(
      authority.accessibleProject({ ...s.ctx }, 'project', 'intruder'),
      e => e.code === 'PROJECT_UNAVAILABLE',
    );
    await lifecycle.permanentlyDelete._handler(
      { ...s.ctx },
      { projectId: 'project', operationId: 'foreign', expectedRevision: 0 },
    );
  } finally {
    console.log = previous;
  }
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const detail = JSON.parse(line.slice('FORGE_PROJECT_EXECUTION '.length));
    assert.deepEqual(detail, { projectId: 'project', name: null });
  }
  assert.equal(s.tables.hostedProjects.get('project').removal, undefined);
});

test('telemetry schema or capacity failures forbid a quiet proof even after deletion and an earlier rate breach', () => {
  const monitor = new ImportBenchmarkMonitor({ ...target, since: 0 });
  monitor.fail('rate');
  monitor.fail('BENCHMARK_LOG_CAPACITY');
  monitor.deleted(0);
  assert.equal(monitor.reason, 'rate');
  assert.equal(monitor.coverageFailure, 'BENCHMARK_LOG_CAPACITY');
  assert.equal(monitor.quiet(600_000), false);
});

test('a failed local stopper cannot prevent server cancellation and approved deletion', async () => {
  const s = fixture();
  const task = await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectGithubImportWorker:run'), {
    id: 'job',
    actor: 'owner',
  });
  const guard = importBenchmarkGuard({
    ...target,
    since: 1000,
    admin: s.admin,
    owner: s.owner,
    stopWorkload: async () => {
      throw Error('local client already gone');
    },
  });
  await guard.stop();
  assert.equal(
    s.tasks.get(task).state.kind,
    'canceled',
    'jobs created before the monitor started are also canceled',
  );
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
  assert.equal(guard.receipts.localStopFailed, true);
});

test('a canceled in-progress action must complete before five quiet minutes can prove no further executions', () => {
  const monitor = new ImportBenchmarkMonitor({ ...target, since: 0 });
  monitor.observe({ ...event('child', 100), requestId: 'slow-root', parentExecutionId: 'execution-root' });
  monitor.deleted(200);
  assert.equal(monitor.running.size, 1);
  assert.equal(monitor.quiet(300_200), false, 'a ten-minute action can outlive five minutes of log silence');
  monitor.observe({ ...event('root', 600_000, 'canceled action completed'), requestId: 'slow-root' });
  assert.equal(monitor.running.size, 0);
  assert.equal(monitor.quiet(899_999), false);
  assert.equal(monitor.quiet(900_000), true);
  // A late child delivery cannot resurrect an already completed parent.
  monitor.observe({
    ...event('late-child', 600_001),
    requestId: 'slow-root',
    parentExecutionId: 'execution-root',
  });
  assert.equal(monitor.running.size, 0);
});

test('legacy megabyte job cursors keep identity reads below the transaction byte window', async () => {
  const s = fixture(),
    originalGet = s.ctx.db.get;
  const cursor = 'x'.repeat(900_000);
  for (let i = 0; i < 21; i++) {
    s.tables.projectGithubImports.set(`wide-${i}`, {
      ...s.tables.projectGithubImports.get('job'),
      _id: `wide-${i}`,
      projectId: 'foreign',
      cursor,
    });
    await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectGithubImportWorker:run'), {
      id: `wide-${i}`,
      actor: 'owner',
    });
  }
  let bytes = 0;
  s.ctx.db.get = async id => {
    const row = await originalGet(id);
    bytes += Buffer.byteLength(JSON.stringify(row));
    return row;
  };
  const page = await benchmark.cancelScheduled._handler(s.ctx, {
    ...target,
    operationId: 'wide-cancel',
    cursor: null,
  });
  assert.equal(page.scanned, 10);
  assert.equal(page.isDone, false);
  assert.equal(page.canceled, 0);
  assert(bytes < 12 * 1024 * 1024, `identity bytes ${bytes}`);
});

test('index scheduler project identities survive generation retirement and remain cancelable and attributable', async () => {
  const s = fixture();
  const index = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
  const task = await s.ctx.scheduler.runAfter(0, makeFunctionReference('projectWorkIndexStore:retire'), {
    generationId: 'already-retired',
    projectId: 'project',
  });
  const result = await benchmark.cancelScheduled._handler(s.ctx, {
    ...target,
    operationId: 'orphan-cancel',
    cursor: null,
  });
  assert.equal(result.canceled, 1);
  assert.equal(s.tasks.get(task).state.kind, 'canceled');
  const lines = [],
    previous = console.log;
  console.log = value => lines.push(value);
  try {
    await index.retire._handler({ ...s.ctx }, { generationId: 'already-retired', projectId: 'project' });
  } finally {
    console.log = previous;
  }
  assert(lines.some(line => line.includes('FORGE_PROJECT_EXECUTION')));
});

test('cached invocations reusing an execution identity still count when their requests differ', () => {
  const monitor = new ImportBenchmarkMonitor({ ...target, since: 0 });
  const first = { ...event('cached-shared', 100), cachedResult: true };
  monitor.observe(first);
  monitor.observe({ ...first, requestId: 'another-client' });
  monitor.observe(first);
  assert.equal(monitor.total, 2);
});
