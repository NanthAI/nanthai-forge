// SPDX-License-Identifier: Apache-2.0
// Cost guard on change (Issue 3e3f9fe6): the landing check runs a scripted landing mix on the
// in-process Convex fixture and judges each per-landing count against the ledger in
// src/speed-budgets.json (`costs`). Deterministic counts, not live billing: a change that adds work
// per landing fails here, a saving asks the author to ratchet the ledger down.
import test from 'node:test';
import { storageClock as fixedClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inboundCostFixture } from './hosted-github-inbound-cost-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { seedFullMain, passWithSelection } from './hosted-race-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state as databaseFixture } from './hosted-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { metricRunRow } from '../dist/self-metrics-run.js';
import {
  inflateDogfoodChecks,
  landingStorage,
  fixedProjectStorage,
  assertFixedProjectStorage,
  storageBudgets,
} from './landing-storage-fixture.mjs';
import { speedBudgets } from '../dist/speed-budgets.js';
import { formatCostVerdicts, judgeCost, judgeCosts } from '../dist/cost-budgets.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { costs, costGuard } = speedBudgets;
const { guardReportFoldOrders } = await import('./hosted-report-fold-guard.mjs');
test(
  'S3 event-order and replay cost: uploader, webhook and confirmation ingest once per run',
  guardReportFoldOrders,
);
const finishApi = await import(moduleUrl('../convex/projectHostedFinish.ts'));
const { landingRequestBodies } = await import(moduleUrl('../convex/projectLandingRequestBody.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
// Action or not, and which runtime, from the registered function and its module's 'use node'.
const kinds = new Map();
async function kind(name) {
  if (kinds.has(name)) return kinds.get(name);
  const [file, method] = name.split(':');
  const path = new URL(`../convex/${file}.ts`, import.meta.url);
  let value = null;
  if (existsSync(path) && (await import(moduleUrl(`../convex/${file}.ts`)))[method]?.isAction)
    value = /^'use node';$/m.test(readFileSync(path, 'utf8').slice(0, 200)) ? 'node' : 'v8';
  kinds.set(name, value);
  return value;
}
const SOURCE = /^(projectConvexSource|projectHostedResolveChain:run)/;

test('S3 phase transitions write only the ticket; cold bytes fall by the measured S0 indexed-patch fit', async t => {
  // S0: tests/fixtures/indexed-patch-usage.json, document bytes +181+128 per custom index.
  // This predicts execution I/O from fixture documents; it is not a billed S3 measurement.
  const fittedWrite = (row, indexes) => Buffer.byteLength(JSON.stringify(row)) + 181 + 128 * indexes;
  for (const size of [1024, 27648]) {
    const f = databaseFixture([]);
    const ctx = landingRequestBodies(f.ctx);
    const request = { channel: 'main', message: 'x'.repeat(size) };
    const value = {
      projectId: 'project',
      channel: 'main',
      submissionId: 'submission',
      operationId: 'operation',
      actor: 'owner',
      sequence: 1,
      runnable: true,
      phase: 'queued',
      runId: null,
      attemptId: 'attempt',
      batchSelection: canonicalPayload({ files: ['synthetic/path.ts'] }),
      value: canonicalPayload({ id: 'submission', phase: 'queued', request }),
    };
    const id = await ctx.db.insert('projectHostedLandingRequests', value);
    const bodies = structuredClone([...f.tables.projectHostedLandingBodies]);
    let bodyWrites = 0;
    for (const method of ['insert', 'patch', 'replace', 'delete']) {
      const original = f.ctx.db[method];
      f.ctx.db[method] = (...args) => {
        if (
          method === 'insert'
            ? args[0] === 'projectHostedLandingBodies'
            : f.tables.projectHostedLandingBodies.has(args[0])
        )
          bodyWrites++;
        return original(...args);
      };
    }
    const logical = await ctx.db.get(id);
    await ctx.db.patch(id, {
      phase: 'checking',
      value: canonicalPayload({ ...JSON.parse(logical.value), phase: 'checking' }),
    });
    assert.equal(
      bodyWrites,
      0,
      'phase changes issue no cold-body write, including a redundant same-value patch',
    );
    const header = f.tables.projectHostedLandingRequests.get(id);
    assert.deepEqual(
      [...f.tables.projectHostedLandingBodies],
      bodies,
      'a phase change never rewrites either cold body',
    );
    const { requestBodyId, selectionBodyId, ...sameIdentity } = header;
    const legacy = {
      ...sameIdentity,
      batchSelection: value.batchSelection,
      value: canonicalPayload({ ...JSON.parse(header.value), request }),
    };
    const before = fittedWrite(legacy, 24),
      after = fittedWrite(header, 24);
    assert(after < before, 'all 24 ticket indexes operate on the smaller header');
    assert(before - after > size - 256, 'cold request bytes do not return on a phase write');
    assert.deepEqual(JSON.parse((await ctx.db.get(id)).value).request, request);
    t.diagnostic(
      JSON.stringify({
        requestBytes: size,
        predictedBefore: before,
        predictedAfter: after,
        predictedReduction: before - after,
        bodyWritesPerPhase: bodyWrites,
        additionalFunctionCalls: 0,
      }),
    );
  }
});

test('S3 report callbacks retain only a nine-index header and never touch report rows', async t => {
  const { checksFixture } = await import('./hosted-checks-fixture.mjs');
  const { checkReportHeader, checkReportPointer } = await import('../dist/check-file-summary.js');
  const { useObjectReports, storeCheckReports } = await import(
    moduleUrl('../convex/projectHostedCheckReports.ts')
  );
  const f = await checksFixture();
  const original = await f.activate((await f.enqueue(f.selection())).id, 1);
  const fittedWrite = row => Buffer.byteLength(JSON.stringify(row)) + 181 + 128 * 9;
  for (const failed of [false, true]) {
    const reports = Object.fromEntries(
      Array.from({ length: 20000 }, (_, i) => [
        `tests/synthetic-${i}.test.mjs`,
        { failed, durationMs: i, ...(failed ? { firstError: 'synthetic failure' } : {}) },
      ]),
    );
    const run = { ...structuredClone(original), contractReports: reports };
    run.reportPointer = checkReportPointer(reports);
    checkReportHeader(run, 7 * 1024);
    useObjectReports(run);
    // Any report-table read/write here is a failure: callback metadata needs no database I/O.
    const metadata = await storeCheckReports(
      {
        db: new Proxy(
          {},
          {
            get() {
              throw new Error('R2 report callback attempted database I/O');
            },
          },
        ),
      },
      run,
    );
    const { contractReports, ...header } = run;
    const stored = { ...metadata, value: canonicalPayload(header) };
    const legacy = { value: canonicalPayload({ ...original, contractReports }) };
    assert.equal(metadata.reportStorage, 'r2');
    assert(Buffer.byteLength(JSON.stringify(stored)) < 12 * 1024);
    assert(Buffer.byteLength(JSON.stringify(header.testFiles)) <= 8 * 1024);
    assert.equal(header.testFiles.counts.total, 20000);
    assert.equal(header.testFiles.counts.failed, failed ? 20000 : 0);
    assert(fittedWrite(stored) < fittedWrite(legacy));
    t.diagnostic(
      JSON.stringify({
        failed,
        predictedBefore: fittedWrite(legacy),
        predictedAfter: fittedWrite(stored),
        reportRowOperations: 0,
        additionalFunctionCalls: 0,
      }),
    );
  }
});

/** Counts every Convex execution and R2 request from now on: metered transactions (queries and
 * mutations), action executions (scheduled and nested), R2 requests by class and bytes put. */
function meter(f, { extraShard = false, extraSetupSeconds = 0 } = {}) {
  // Signed synthetic runner usage, including job-side setup, makes shard fanout visible even
  // when the number of check runs is unchanged. No wall-clock measurement or real sleep.
  if (extraShard) f.rawChecks.setPlanOverrides({ shardCount: 3 });
  f.rawChecks.pass = async run => {
    for (let index = 0; index < run.plan.shardCount; index++)
      await f.rawChecks.callback(
        f.rawChecks.shard(run, index, 'passed', {
          execution: {
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: new Date(Date.UTC(2026, 0, 1) + (120 + extraSetupSeconds) * 1000).toISOString(),
            seconds: 120 + extraSetupSeconds,
          },
        }),
      );
    return f.rawChecks.callback(f.rawChecks.complete(run));
  };
  const candidatesBefore = new Set(f.tables.projectHostedRecords.keys());
  const from = f.counts.length,
    sourceFrom = f.metrics.convexSourceCalls.length,
    reuseFrom = f.reuseDecisions?.length ?? 0,
    tasks = [],
    r2 = { a: 0, b: 0, bytesPut: 0 },
    inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'api.github.com') return inner(url, init);
    // R2 class A: PUT (and LIST); class B: GET and HEAD.
    if (init?.method === 'PUT') {
      r2.a++;
      r2.bytesPut += Buffer.byteLength(init.body);
    } else r2.b++;
    return inner(url, init);
  };
  return {
    tasks,
    async stop() {
      globalThis.fetch = inner;
      for (const row of f.tables.projectHostedRecords.values())
        if (
          !candidatesBefore.has(row._id) &&
          row.kind === 'candidate' &&
          JSON.parse(row.inline ?? f.tables.projectHostedRecordBodies.get(row.bodyId).value).result.status ===
            'clean'
        )
          assert(row.candidateFiles, 'every clean Candidate producer pins its source listing');
      const counts = f.counts.slice(from);
      const observers = counts.filter(c => c.name === 'observerBudgetPage');
      const sum = key => counts.reduce((total, c) => total + c[key], 0);
      // Source tasks record themselves in convexSourceCalls with their nested actions.
      const actions = [
        ...tasks.filter(name => !SOURCE.test(name)),
        ...f.metrics.convexSourceCalls.slice(sourceFrom),
      ];
      const runtimes = await Promise.all(actions.map(kind));
      return {
        dataRecordCalls: counts.filter(c => c.touched.includes('projectWorkDataRecords')).length,
        queries: counts.filter(c => c.query && c.name !== 'observerBudgetPage').length,
        observerQueries: observers.length,
        observerReadBytes: observers.reduce((n, c) => n + c.readBytes, 0),
        mutations: counts.filter(c => !c.query).length,
        v8Actions: runtimes.filter(r => r === 'v8').length + (f.reuseDecisions?.length ?? 0) - reuseFrom,
        nodeActions: runtimes.filter(r => r === 'node').length,
        readBytes: sum('readBytes') - observers.reduce((n, c) => n + c.readBytes, 0),
        writeBytes: sum('writeBytes'),
        r2ClassA: r2.a,
        r2ClassB: r2.b,
        r2BytesPut: r2.bytesPut,
        // Whole-row reads of main's path history (Issue 750c5929: 140 KB on Forge, read only by the
        // acceptance write that moves it; landing names and Lanes behind main use the per-landing log).
        mainHistoryReads: counts.reduce(
          (total, c) => total + (c.readDocumentsByTable?.projectHostedOverlapMain ?? 0),
          0,
        ),
      };
    },
  };
}
async function run(f, m, task) {
  m.tasks.push(task.name);
  await f.execute(task);
  await m.refresh?.();
}
/** Convex subscriptions rerun only after a selected read dependency changes. Use the same fake
 * read sets as the observer contract tests; no timer, polling, or forced per-task query. */
function watch(f, m, operationId) {
  let reads,
    version = 0;
  m.refresh = async () => {
    if (reads?.()) return;
    const page = JSON.parse(
      await f.tx('observerBudgetPage', observe.page, {
        projectId: f.projectId,
        operationId,
        nextVersion: version,
      }),
    );
    reads = f.readSet();
    version = page.nextVersion;
  };
  return m.refresh();
}
async function drain(f, m) {
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 200, 'finite landing work');
    await run(f, m, f.pending()[0]);
  }
}
/** The cost counts each landed state carries (state.counts): what the live budgets are judged on. */
const stamped = f =>
  [...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value).counts ?? null);
const runs = f => [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value));
const runnerMinutes = f =>
  [...f.tables.projectHostedCheckShards.values()].reduce((sum, row) => {
    const shard = JSON.parse(row.value);
    assert(shard.execution, 'every completed fixture shard retains signed runner seconds');
    return sum + shard.execution.seconds / 60;
  }, 0);
function assertRunMetrics(f) {
  for (const row of f.tables.projectHostedCheckRuns.values()) {
    const projection = [...f.tables.projectFinishReadRows.values()].find(
      p => p.kind === 'projectMetricCheckRuns' && p.sourceId === row._id,
    );
    assert(projection, 'every landed run has its metric row from the existing mutation');
    assert.equal(row.metricsProjected, true);
    assert.deepEqual(JSON.parse(projection.value), metricRunRow(JSON.parse(row.value)));
  }
}

const landed = f =>
  [...f.tables.projectHostedLandingRequests.values()].filter(r => JSON.parse(r.value).phase === 'landed')
    .length;

/** One accepted-Candidate submission through check and acceptance; `moveMain` moves main during
 * the check, so it recomposes on a source job and checks again (the common dogfood case). */
async function solo(t, { moveMain = false, extraQuery = false, durations = false, ...runner } = {}) {
  const f = await finishFixture(t);
  const m = meter(f, runner);
  const state = await f.enqueue(
    f.request(),
    durations
      ? {
          gates: JSON.stringify({
            lanes: [
              {
                laneId: f.lane.laneId,
                head: f.lane.head,
                preflight: 'passed',
                saveMs: 15000,
                preflightMs: 49779,
              },
            ],
          }),
        }
      : {},
  );
  if (extraQuery) {
    // The seeded regression: one more query per landing (a status read on the landing path).
    assert(finishApi.status.isQuery);
    await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  }
  await watch(f, m, state.operationId);
  await drain(f, m);
  for (let round = 0; round < (moveMain ? 2 : 1); round++) {
    if (moveMain && round === 0) f.moveMain();
    await f.passChecks();
    await m.refresh();
    await drain(f, m);
  }
  assert.equal(landed(f), 1);
  assertRunMetrics(f);
  return {
    landings: 1,
    checkRuns: runs(f).length,
    runnerMinutes: runnerMinutes(f),
    stamped: stamped(f),
    ...(await m.stop()),
  };
}
/** Four queued landings composed and checked together under the default batching policy. */
async function batch(t, { extraQuery = false, ...runner } = {}) {
  const f = await batchesFixture(t, { count: 0, batching: 'default', batchMaxSize: null });
  const entries = [];
  for (let i = 0; i < 4; i++) entries.push(await f.add(i));
  // Measured after enqueue: Candidate composition and the four enqueue mutations are outside it.
  const m = meter(f, runner);
  const observers = [];
  for (const state of entries) {
    const observer = {};
    await watch(f, observer, state.operationId);
    observers.push(observer.refresh);
  }
  m.refresh = async () => {
    for (const refresh of observers) await refresh();
  };
  if (extraQuery)
    for (const state of entries)
      await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  for (let steps = 0; ; steps++) {
    assert(steps < 400, 'finite batch work');
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
    const queued = f.runs().filter(r => r.status === 'queued');
    for (const r of queued) await f.rawChecks.pass(await f.rawChecks.activate(r.id));
    // Event-driven work first; a stall alarm only when nothing else can move.
    await m.refresh();
    const task =
      f.pending().find(x => !x.name.startsWith('projectHostedLandingStall')) ??
      (queued.length ? null : f.pending()[0]);
    if (task) await run(f, m, task);
    else if (!queued.length) break;
  }
  assert.equal(landed(f), 4);
  assertRunMetrics(f);
  return {
    landings: 4,
    checkRuns: f.runs().length,
    runnerMinutes: runnerMinutes(f),
    stamped: stamped(f),
    ...(await m.stop()),
  };
}

/** The scripted mix in `costGuard.scenario`, per accepted landing. */
async function measureLandingCosts(t, options = {}) {
  const scenarios = {
    solo: await solo(t, options),
    mainMoved: await solo(t, { ...options, moveMain: true }),
    batchOfFour: await batch(t, options),
  };
  const all = Object.values(scenarios);
  const total = key => all.reduce((sum, s) => sum + s[key], 0);
  const landings = total('landings');
  const per = key => total(key) / landings;
  const { v8, node } = costGuard.actionModel;
  const measured = {
    queries: per('queries'),
    observerQueries: per('observerQueries'),
    observerReadBytes: per('observerReadBytes'),
    mutations: per('mutations'),
    v8Actions: per('v8Actions'),
    nodeActions: per('nodeActions'),
    readBytes: per('readBytes'),
    writeBytes: per('writeBytes'),
    actionGbSeconds: per('v8Actions') * v8.gb * v8.seconds + per('nodeActions') * node.gb * node.seconds,
    r2ClassA: per('r2ClassA'),
    r2ClassB: per('r2ClassB'),
    r2BytesPut: per('r2BytesPut'),
    checkRuns: per('checkRuns'),
    runnerMinutes: per('runnerMinutes'),
    mainHistoryReads: per('mainHistoryReads'),
  };
  return { measured, scenarios, landings };
}

let baseline;
test('cost guard: the scripted landing mix stays within its per-landing cost ledger', async t => {
  const started = performance.now();
  baseline = await measureLandingCosts(t);
  const verdicts = judgeCosts(costs, costGuard, 'landing-fixture', baseline.measured);
  const lines = formatCostVerdicts(verdicts);
  // Warnings and ratchet notices go to the check log; only a fail stops the landing.
  for (const line of lines) t.diagnostic(line);
  if (verdicts.some(v => v.status !== 'pass')) console.warn(lines.join('\n'));
  t.diagnostic(`scenarios ${JSON.stringify(baseline.scenarios)}`);
  t.diagnostic(`measured in ${Math.round(performance.now() - started)} ms`);
  assert.equal(baseline.landings, 6);
  assert(
    baseline.measured.mutations <= 27.5,
    'metrics read projections must share existing landing mutations (90-minute read-cost incident)',
  );
  assert(verdicts.length >= 10, 'every fixture quantity has a ledger entry');
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail').map(v => v.message),
    [],
    'a per-landing cost rose past its ledger threshold',
  );
});

test('unconditional Candidate listings keep the landing call ledger and zero legacy data-table access', () => {
  const unchangedCalls = {
    queries: 0,
    observerQueries: 53 / 6,
    mutations: 163 / 6,
    v8Actions: 59 / 6,
    nodeActions: 3 / 6,
  };
  for (const [metric, limit] of Object.entries(unchangedCalls))
    assert(baseline.measured[metric] <= limit, `listing publication adds no ${metric}`);
  for (const scenario of Object.values(baseline.scenarios))
    assert.equal(
      scenario.dataRecordCalls,
      0,
      'canonical landings never access the legacy per-file data table',
    );
});

test('runner-minute ledger rejects extra shard setup without an increase in check runs', async t => {
  for (const options of [{ extraShard: true }, { extraSetupSeconds: 60 }]) {
    const seeded = await measureLandingCosts(t, options);
    assert.equal(seeded.measured.checkRuns, baseline.measured.checkRuns);
    assert(seeded.measured.runnerMinutes > baseline.measured.runnerMinutes);
    const verdict = judgeCosts(costs, costGuard, 'landing-fixture', seeded.measured).find(
      v => v.metric === 'runnerMinutes',
    );
    assert(verdict, 'runner minutes must be judged by the existing fixture ledger');
    assert.equal(verdict.status, 'fail', 'repeated setup or wider fanout must fail the landing check');
    assert.match(verdict.message, /Decision it protects: Issue 685774ea/);
  }
});

test('seeded regression: one extra query per landing fails the guard, naming the quantity, both values, the decision and the two ways out', async t => {
  const seeded = await measureLandingCosts(t, { extraQuery: true });
  const queries = judgeCosts(costs, costGuard, 'landing-fixture', seeded.measured).find(
    v => v.metric === 'queries',
  );
  assert.equal(queries.status, 'fail');
  assert.equal(queries.after, queries.before + 1);
  assert.match(queries.message, /^Cost budget landing-queries rose: \S+ -> \S+ calls per landing/);
  assert.match(queries.message, /Decision it protects: Issue [0-9a-f]{8}/);
  assert.match(queries.message, /fix the change, or update this entry in src\/speed-budgets\.json/);
});

test('a saving of 10% or more asks the author to lower the ledger value, so it ratchets in', () => {
  assert(baseline, 'runs after the guard measurement');
  const entry = costs.find(c => c.metric === 'mutations');
  // The ledger as it stood before a change that saved a fifth of the landing mutations.
  const verdict = judgeCost(
    { ...entry, value: baseline.measured.mutations * 1.25 },
    baseline.measured.mutations,
    costGuard,
  );
  assert.equal(verdict.status, 'ratchet');
  assert.match(verdict.message, /fell: .* \(-20%\)/);
  assert.match(verdict.message, /Lower its value to \S+ in src\/speed-budgets\.json/);
  // Between the warn and fail lines it warns; within the floor nothing moves.
  const warn = judgeCost({ ...entry, value: 100, floor: 0 }, 110, costGuard);
  assert.equal(warn.status, 'warn');
  assert.equal(judgeCost({ ...entry, value: 2, floor: 1 }, 3, costGuard).status, 'pass');
  assert.equal(judgeCost({ ...entry, value: 2, floor: 0.5 }, null, costGuard).status, 'fail');
});

for (const mainRace of [false, true])
  test(`cost 298f9675: ${mainRace ? 'main-race' : 'solo'} landing preserves check wall, acceptance delay and zero idle calls`, async t => {
    fixedClock(t);
    const f = await finishFixture(t);
    const state = await f.enqueue(f.request());
    const checkWorkMs = 60_000;
    let completed = 0;
    const current = () =>
      JSON.parse(
        [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id).value,
      );
    for (let step = 0; current().phase !== 'landed'; step++) {
      assert(step < 100, 'finite event-driven landing');
      const queued = runs(f).filter(run => run.status === 'queued');
      if (queued.length) {
        for (const run of queued) {
          const active = await f.rawChecks.activate(run.id);
          if (mainRace && completed === 0) f.moveMain();
          // The fixture owns Date.now: model runner work without sleeping or timing the host.
          f.advanceClock(checkWorkMs);
          await f.rawChecks.pass(active);
          completed++;
        }
      } else await f.execute();
    }
    await f.drain();
    const timing = current().timing;
    const measured = {
      timeToMainMs: Date.parse(timing.committedAt) - Date.parse(timing.submittedAt),
      checkWallMs: runs(f).reduce((sum, run) => sum + Date.parse(run.endedAt) - Date.parse(run.at), 0),
      checks: completed,
    };
    t.diagnostic(JSON.stringify({ mainRace, ...measured }));
    assert.equal(completed, mainRace ? 2 : 1, 'only the necessary exact-source checks run');
    assert.equal(measured.checkWallMs, checkWorkMs * completed);
    assert.equal(
      measured.timeToMainMs,
      measured.checkWallMs + (mainRace ? 250 : 0),
      'only the existing main-race publication debounce delays acceptance',
    );
    assert.equal(f.pending().length, 0, 'terminal landing has no live scheduled work');
    const idle = { calls: f.counts.length, sourceCalls: f.metrics.convexSourceCalls.length };
    f.advanceClock(24 * 60 * 60_000);
    await f.drain();
    assert.deepEqual(
      { calls: f.counts.length, sourceCalls: f.metrics.convexSourceCalls.length },
      idle,
      'a day idle adds no Convex execution',
    );
  });

test('live R2 stamp: a recomposed landing carries the requests its compose signed, never more than the meter saw; a landing with no compose of its own stays unknown', () => {
  assert(baseline, 'runs after the guard measurement');
  const { solo, mainMoved, batchOfFour } = baseline.scenarios;
  // The solo landing took its Candidate as given (the fixture composes nothing for it).
  assert.deepEqual(solo.stamped, [null]);
  const [counts] = mainMoved.stamped;
  const [a, b, put] = counts.r2;
  assert(a > 0 && b > 0 && put > 0, 'the recompose signed writes, reads and bytes');
  // The meter counts every R2 request of the whole scenario (checks and the begin reads too).
  assert(
    a <= mainMoved.r2ClassA && b <= mainMoved.r2ClassB && put <= mainMoved.r2BytesPut,
    JSON.stringify({ counts, mainMoved }),
  );
  assert.deepEqual(
    batchOfFour.stamped,
    [null, null, null, null],
    'batch members have no compose of their own',
  );
});

// Dogfood-sized control path: 1,000 retained test reports, ten completed shards. The runner
// callbacks finish before we enlarge the retained row, so this isolates the landing drivers.
async function dogfoodDriverCosts(t) {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  const runBytes = inflateDogfoodChecks(f);
  const from = f.counts.length;
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const calls = f.counts.slice(from).filter(c => c.name === 'finishLandingAdvance');
  const readBytes = calls.reduce((n, c) => n + c.readBytes, 0);
  t.diagnostic(
    JSON.stringify({ runBytes, calls: calls.length, readBytes, tables: calls.map(c => c.readBytesByTable) }),
  );
  return { runBytes, calls: calls.length, readBytes };
}

test('dogfood landing drivers retain exact acceptance with 1,000 reports and ten shards', async t => {
  const measured = await dogfoodDriverCosts(t);
  assert(measured.runBytes >= 250_000 && measured.runBytes < 350_000);
  assert.equal(measured.calls, 1, 'one advance for the passed run, no added RPC');
  const budget = costs.find(c => c.metric === 'landingAdvanceReadBytes');
  assert(budget, 'the dogfood per-function read budget is recorded');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
});

test('observer driver bytes include public identity mapping and recheck current membership', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  f.patch('hostedProjects', f.projectId, { agentGuidance: 'synthetic'.repeat(2000) });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'viewer' });
  const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
  const input = { projectId: f.projectId, operationId: state.operationId, nextVersion: 0 };
  const from = f.counts.length;
  const response = JSON.parse(await f.tx('driverObservePage', observe.page, input, 'viewer'));
  assert.equal(response.submission.actor, 'synthetic-owner');
  const measured = f.counts.at(-1);
  assert.equal(f.counts.length - from, 1, 'one query including public identity mapping');
  t.diagnostic(JSON.stringify({ observerReadBytes: measured.readBytes, tables: measured.readBytesByTable }));
  const budget = costs.find(c => c.metric === 'finishObserveReadBytes');
  assert(budget, 'the public observer byte budget is recorded');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
  f.tables.projectContributors.delete(member);
  await assert.rejects(
    f.tx('driverObserveRevoked', observe.page, input, 'viewer'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.insert('projectReaders', { projectId: f.projectId, reader: 'viewer' });
  const reader = JSON.parse(await f.tx('driverObserveReader', observe.page, input, 'viewer'));
  assert.equal(reader.submission.actor, undefined, 'a read grant does not disclose another person');
});

async function dogfoodControlTail(t, race) {
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, { agentGuidance: 'synthetic'.repeat(2000) });
  const state = await f.enqueue(f.request({ agent: true }));
  await f.drain();
  const first = (await f.status(state.id)).attempt;
  const selection = f.c.put(JSON.stringify({ scope: 'full', tests: [] }));
  await passWithSelection(f, first.check.runId, selection);
  if (race) {
    while ((await f.current(state.id)).submission.phase !== 'ready') await f.execute();
    f.moveMain();
    await seedFullMain(f, selection);
  }
  inflateDogfoodChecks(f);
  const from = f.counts.length;
  await f.drain();
  if (race) {
    await f.passChecks();
    inflateDogfoodChecks(f);
    await f.drain();
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  return Object.fromEntries(
    ['finishStep', 'finishLandingAdvance', 'reuseComplete'].map(name => {
      const rows = f.counts.slice(from).filter(c => c.name === name);
      return [
        name,
        {
          calls: rows.length,
          readBytes: rows.reduce((sum, c) => sum + c.readBytes, 0),
          runReads: rows.reduce((sum, c) => sum + (c.readDocumentsByTable.projectHostedCheckRuns ?? 0), 0),
        },
      ];
    }),
  );
}

test('dogfood control tails budget finish reads across a completed solo landing and main-race recheck', async t => {
  const scenarios = [await dogfoodControlTail(t, false), await dogfoodControlTail(t, true)];
  const total = (name, key) => scenarios.reduce((sum, s) => sum + s[name][key], 0);
  const measured = {
    finishStepReadBytes: total('finishStep', 'readBytes') / 2,
    reuseCompleteReadBytes: total('reuseComplete', 'readBytes') / 2,
    driverTailReadBytes:
      scenarios.reduce((sum, s) => sum + Object.values(s).reduce((n, c) => n + c.readBytes, 0), 0) / 2,
  };
  assert.equal(total('finishStep', 'calls'), 13, 'no additional finish step at dogfood row sizes');
  assert.equal(total('finishLandingAdvance', 'calls'), 3, 'no additional landing advance');
  assert.equal(total('reuseComplete', 'calls'), 1, 'one proof completion for the main race');
  for (const [metric, bytes] of Object.entries(measured)) {
    const budget = costs.find(c => c.metric === metric);
    assert(budget, `${metric} has a ledger entry`);
    assert.notEqual(judgeCost(budget, bytes, costGuard).status, 'fail');
  }
  t.diagnostic(JSON.stringify({ dogfoodTail: { scenarios, measured } }));
});

test('save/preflight timing keeps landing cost guard bytes within one percent without extra calls', async t => {
  const before = await solo(t, { moveMain: true });
  const after = await solo(t, { moveMain: true, durations: true });
  for (const key of ['queries', 'observerQueries', 'mutations', 'v8Actions', 'nodeActions'])
    assert.equal(after[key], before[key], `${key}: no new call`);
  for (const key of ['readBytes', 'writeBytes', 'observerReadBytes'])
    assert(after[key] <= before[key] * 1.01, `${key}: ${after[key]} <= ${before[key]} + 1%`);
  t.diagnostic(
    `duration bytes: read ${after.readBytes - before.readBytes}, write ${after.writeBytes - before.writeBytes}; baseline ${before.readBytes}/${before.writeBytes}`,
  );
});

test('overlap driver bytes include changed peers, presence, board and public identity mapping', async t => {
  const f = await finishFixture(t);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    agentGuidance: 'synthetic'.repeat(2000),
    autonomyPolicy: {
      ...project.autonomyPolicy,
      agentDefaults: { ...project.autonomyPolicy.agentDefaults, dormantAfterDays: 0 },
    },
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'viewer' });
  const peer = await f.c.lane(f.lane.state.object);
  f.insert('projectBoardInboxes', {
    projectId: f.projectId,
    key: `lane:${f.lane.laneId}`,
    latestAt: 10,
    count: 1,
  });
  f.insert('projectBoardMessages', {
    projectId: f.projectId,
    id: 'synthetic-driver-note',
    author: 'owner',
    fromLaneId: peer.laneId,
    targetKey: `lane:${f.lane.laneId}`,
    body: 'Synthetic peer note',
    bytes: 19,
    bodyHash: 'synthetic',
    at: 10,
    expiresAt: Date.now() + 86_400_000,
  });
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
  const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
  const changes = Array.from({ length: 50 }, (_, i) => ({
    path: `src/synthetic-${i}.ts`,
    before: { blob: 'a'.repeat(64), mode: 'file' },
    after: { blob: 'b'.repeat(64), mode: 'file' },
    evidence: { baseBlob: 'a'.repeat(64), ranges: [{ start: 0, end: 1 }], symbols: [] },
  }));
  await f.tx(
    'seedOverlapDriver',
    {
      _handler: async ctx => {
        for (const entry of [f.lane, peer]) {
          const row = await records.readHostedRecord(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            kind: 'lane',
            key: entry.laneId,
          });
          await tracking.trackHostedOverlapLane(ctx, f.projectId, JSON.parse(row.value), {
            baseSequence: 0,
            intent: 'Synthetic driver changes',
            changes,
          });
        }
      },
    },
    {},
  );
  const input = {
    projectId: f.projectId,
    laneId: f.lane.laneId,
    path: 'src/synthetic-0.ts',
    detail: true,
    presence: {},
    board: { after: 0 },
  };
  const from = f.counts.length;
  const response = JSON.parse(await f.tx('driverOverlapRead', overlaps.read, input, 'viewer'));
  assert.equal(f.counts.length - from, 1, 'one query including all public mapping');
  assert.equal(response.peerEvidence.items.length, 1);
  assert(response.presence);
  assert(response.board);
  const measured = f.counts.at(-1);
  t.diagnostic(JSON.stringify({ overlapReadBytes: measured.readBytes, tables: measured.readBytesByTable }));
  const budget = costs.find(c => c.metric === 'overlapReadBytes');
  assert(budget, 'the full overlap query has a byte budget');
  assert.notEqual(judgeCost(budget, measured.readBytes, costGuard).status, 'fail');
  f.tables.projectContributors.delete(member);
  await assert.rejects(
    f.tx('driverOverlapRevoked', overlaps.read, input, 'viewer'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.insert('projectReaders', { projectId: f.projectId, reader: 'viewer' });
  const reader = JSON.parse(await f.tx('driverOverlapReader', overlaps.read, input, 'viewer'));
  assert.equal(reader.presence, undefined);
  assert.equal(reader.board, undefined);
  assert(
    !JSON.stringify(reader).includes('synthetic-owner'),
    'read-only access does not name another person',
  );
});

// GitHub pushes pay both the import and the normal landing, independently of the six-Candidate mix.
test('GitHub inbound cost: one changed blob imports, composes, checks, lands and drains without idle work', async t => {
  const f = await finishFixture(t);
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const inbound = await inboundCostFixture(t, f);
  const m = meter(f);
  await inbound.receive();
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 200, 'one push has finite work');
    await f.passChecks();
    const task = f.pending()[0];
    m.tasks.push(task.name);
    await inbound.execute(task);
  }
  const counts = await m.stop();
  const { v8, node } = costGuard.actionModel;
  const measured = {
    ...counts,
    ...inbound.assertLanded(),
    actionGbSeconds: counts.v8Actions * v8.gb * v8.seconds + counts.nodeActions * node.gb * node.seconds,
    checkRuns: runs(f).length - 1,
  };
  t.diagnostic(`inbound ${JSON.stringify(measured)}`);
  const verdicts = judgeCosts(costs, costGuard, 'github-inbound-fixture', measured);
  for (const line of formatCostVerdicts(verdicts)) t.diagnostic(line);
  assert.equal(verdicts.length, 13, 'every inbound quantity is ratcheted in the shared ledger');
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail').map(v => v.message),
    [],
  );
  const doubled = judgeCosts(costs, costGuard, 'github-inbound-fixture', {
    ...measured,
    readBytes: measured.readBytes * 2,
  }).find(v => v.metric === 'readBytes');
  assert.equal(doubled.status, 'fail', 'duplicate inbound I/O cannot hide in the outbound mix');
  assert.match(doubled.message, /Decision it protects: Issue 3e3f9fe6/);
});

test('storage per landing ratchets every table on fresh and dogfood-shaped checks before and after exhaust expiry', async t => {
  fixedClock(t);
  const scenarios = {
    fresh: await landingStorage(t, false, { capsules: true, journals: true }),
    dogfood: await landingStorage(t, true, { capsules: true, journals: true }),
  };
  t.diagnostic(`storagePerLanding ${JSON.stringify(scenarios)}`);
  for (const [name, scenario] of Object.entries(scenarios)) {
    assert.equal(scenario.capsule.classA, 1, `${name}: one complete capsule PUT`);
    assert(scenario.capsule.compressedBytes < 100_000, `${name}: capsule egress budget`);
    for (const [phase, tables] of Object.entries(scenario.perProject))
      assertFixedProjectStorage(tables, storageBudgets[name].perProject[phase], `${name}/${phase}`);
    for (const [phase, tables] of Object.entries(scenario.perLanding)) {
      for (const [table, stored] of Object.entries(tables)) {
        assert(
          table in storageBudgets[name][phase],
          `${name}/${phase}/${table}: record the new table's storage decision`,
        );
        assert(
          stored <= storageBudgets[name][phase][table],
          `${name}/${phase}/${table}: ${stored} > ${storageBudgets[name][phase][table]} bytes per landing; fix growth or record the Issue's reason and ratchet`,
        );
      }
    }
  }
});

test('fixed per-project storage cannot hide duplicate rows or landing history behind the accounting split', async () => {
  const f = await acceptanceFixture();
  const { trackHostedOverlapMain } = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
  const paths = Array.from({ length: 128 }, (_, i) => `src/file-${i}.ts`);
  const advance = sequence =>
    f.transaction(
      'fixedStorageHistory',
      {
        _handler: ctx => trackHostedOverlapMain(ctx, f.projectId, sequence, paths),
      },
      {},
    );
  await advance(1000);
  const baseline = fixedProjectStorage(f);
  // More than the 64-entry log window, with fixed-width sequence numbers: updating latest
  // touches must not retain another main row or append history inside the singleton.
  for (let sequence = 1001; sequence <= 1128; sequence++) {
    await advance(sequence);
    const current = fixedProjectStorage(f);
    assertFixedProjectStorage(current, storageBudgets.dogfood.perProject.retained, 'history');
    assert.deepEqual(current, baseline, 'the same paths and project retain no per-landing history');
  }
  assert.equal(f.tables.projectHostedOverlapMainLog.size, 64, 'the separate history log stays bounded');
  const row = [...f.tables.projectHostedOverlapMain.values()][0];
  f.patch('projectHostedOverlapMain', row._id, { changes: row.changes + ' '.repeat(100_000) });
  assert.throws(
    () =>
      assertFixedProjectStorage(
        fixedProjectStorage(f),
        storageBudgets.dogfood.perProject.retained,
        'history',
      ),
    /bytes per project/,
    'history appended inside the existing row must fail the byte ratchet',
  );
  f.patch('projectHostedOverlapMain', row._id, { changes: row.changes });
  const { _id, _creationTime, ...duplicate } = row;
  f.insert('projectHostedOverlapMain', duplicate);
  assert.throws(
    () =>
      assertFixedProjectStorage(
        fixedProjectStorage(f),
        storageBudgets.dogfood.perProject.retained,
        'history',
      ),
    /rows per project/,
    'another singleton copy must fail even when both rows fit the byte budget',
  );
});
