// SPDX-License-Identifier: Apache-2.0
// Cost guard on change (Issue 3e3f9fe6): the landing check runs a scripted landing mix on the
// in-process Convex fixture and judges each per-landing count against the ledger in
// src/speed-budgets.json (`costs`). Deterministic counts, not live billing: a change that adds work
// per landing fails here, a saving asks the author to ratchet the ledger down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inboundCostFixture } from './hosted-github-inbound-cost-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { seedFullMain, passWithSelection } from './hosted-race-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { metricRunRow } from '../dist/self-metrics-run.js';
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
const finishApi = await import(moduleUrl('../convex/projectHostedFinish.ts'));
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

/** Counts every Convex execution and R2 request from now on: metered transactions (queries and
 * mutations), action executions (scheduled and nested), R2 requests by class and bytes put. */
function meter(f) {
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
async function solo(t, { moveMain = false, extraQuery = false, durations = false } = {}) {
  const f = await finishFixture(t);
  const m = meter(f);
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
  return { landings: 1, checkRuns: runs(f).length, stamped: stamped(f), ...(await m.stop()) };
}
/** Four queued landings composed and checked together under the default batching policy. */
async function batch(t, { extraQuery = false } = {}) {
  const f = await batchesFixture(t, { count: 0, batching: 'default', batchMaxSize: null });
  const entries = [];
  for (let i = 0; i < 4; i++) entries.push(await f.add(i));
  // Measured after enqueue: Candidate composition and the four enqueue mutations are outside it.
  const m = meter(f);
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
  return { landings: 4, checkRuns: f.runs().length, stamped: stamped(f), ...(await m.stop()) };
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

function inflateDogfoodChecks(f) {
  const reports = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `tests/hosted-${String(i).padStart(4, '0')}-${'synthetic-path-'.repeat(10)}.test.mjs`,
      { durationMs: 1234.567, failed: false, attempts: [{ durationMs: 1234.567, failed: false }] },
    ]),
  );
  let runBytes = 0;
  for (const row of f.tables.projectHostedCheckRuns.values()) {
    const run = JSON.parse(row.value);
    if (run.status !== 'passed') continue;
    run.contractReports = reports;
    run.plan.shardCount = 10;
    run.counts = { completed: 10, passed: 10, failed: 0 };
    const value = JSON.stringify(run);
    runBytes = Buffer.byteLength(value);
    f.patch('projectHostedCheckRuns', row._id, { value });
  }
  return runBytes;
}

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

// Net retained JSON document bytes, rather than cumulative write traffic. Identities retain their
// lengths; normalize only the synthetic creation clock. Index/system/R2 bytes are separate costs.
function storedBytes(f) {
  return Object.fromEntries(
    Object.entries(f.tables)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, rows]) => [
        name,
        [...rows.values()].reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })),
          0,
        ),
      ]),
  );
}
async function landingStorage(t, dogfood) {
  const f = await finishFixture(
    t,
    dogfood
      ? {
          fileCount: 4096,
          selectedFileCount: 128,
          beforeSourceMutation: (_name, args) => {
            // A synthetic input, like the fixture's fixed clock: real RPC timing digits must not
            // make byte storage depend on the host OS. New fields and step counts still ratchet.
            if (args.timing)
              for (const key of ['runMs', 'readMs', 'writeMs', 'callMs', 'bootMs']) {
                if (key in args.timing) args.timing[key] = 0;
              }
          },
        }
      : {},
  );
  const before = storedBytes(f);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  if (dogfood) {
    inflateDogfoodChecks(f);
    f.moveMain();
  }
  await f.drain();
  if (dogfood) {
    await f.passChecks();
    inflateDogfoodChecks(f);
    await f.drain();
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const delta = () =>
    Object.fromEntries(
      Object.entries(storedBytes(f)).map(([table, size]) => [table, Math.max(0, size - before[table])]),
    );
  const immediate = delta();
  const expiry = await import(moduleUrl('../convex/projectOperationalExpiry.ts'));
  const checks = [...f.tables.projectHostedCheckRuns.values()];
  // Controlled clock, no sleeps: maintenance is due after the landing has completed.
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 86_400_000;
  try {
    for (const row of checks)
      for (const phase of ['callbacks', 'detail']) {
        let more = true;
        for (let i = 0; more && i < 100; i++)
          more = (
            await f.c.transaction('storageExpiry', expiry.check, {
              projectId: f.projectId,
              runId: row.runId,
              phase,
              operationId: `exhaust:${row.runId}:${phase}`,
              part: i,
              dueAt: 0,
              continue: false,
            })
          ).more;
        assert.equal(more, false);
      }
    for (const row of f.tables.projectSourceSteps.values()) {
      let more = true;
      for (let part = 0; more && part < 100; part++)
        more = (
          await f.c.transaction('storageSourceExpiry', expiry.source, {
            projectId: f.projectId,
            jobId: row.jobId,
            dueAt: 0,
            continue: false,
            operationId: `exhaust:${row.jobId}:source`,
            part,
          })
        ).more;
      assert.equal(more, false);
    }
  } finally {
    Date.now = realNow;
  }
  const retained = delta();
  return { immediate, retained };
}

test('storage per landing ratchets every table on fresh and dogfood-shaped checks before and after exhaust expiry', async t => {
  const OriginalDate = Date;
  class StorageDate extends OriginalDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(StorageDate.now());
    }
    static now() {
      return OriginalDate.UTC(2026, 10, 10, 12);
    }
  }
  globalThis.Date = StorageDate;
  t.after(() => {
    globalThis.Date = OriginalDate;
  });
  const scenarios = { fresh: await landingStorage(t, false), dogfood: await landingStorage(t, true) };
  t.diagnostic(`storagePerLanding ${JSON.stringify(scenarios)}`);
  const budgets = JSON.parse(
    readFileSync(new URL('./fixtures/landing-storage-budget.json', import.meta.url), 'utf8'),
  );
  for (const [name, scenario] of Object.entries(scenarios))
    for (const [phase, tables] of Object.entries(scenario)) {
      for (const [table, stored] of Object.entries(tables)) {
        assert(
          table in budgets[name][phase],
          `${name}/${phase}/${table}: record the new table's storage decision`,
        );
        assert(
          stored <= budgets[name][phase][table],
          `${name}/${phase}/${table}: ${stored} > ${budgets[name][phase][table]} bytes per landing; fix growth or record the Issue's reason and ratchet`,
        );
      }
    }
});
