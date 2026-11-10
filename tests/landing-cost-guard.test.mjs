// SPDX-License-Identifier: Apache-2.0
// Cost guard on change (Issue 3e3f9fe6): the landing check runs a scripted landing mix on the
// in-process Convex fixture and judges each per-landing count against the ledger in
// src/speed-budgets.json (`costs`). Deterministic counts, not live billing: a change that adds work
// per landing fails here, a saving asks the author to ratchet the ledger down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
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
      const sum = key => counts.reduce((total, c) => total + c[key], 0);
      // Source tasks record themselves in convexSourceCalls with their nested actions.
      const actions = [
        ...tasks.filter(name => !SOURCE.test(name)),
        ...f.metrics.convexSourceCalls.slice(sourceFrom),
      ];
      const runtimes = await Promise.all(actions.map(kind));
      return {
        queries: counts.filter(c => c.query).length,
        mutations: counts.filter(c => !c.query).length,
        v8Actions: runtimes.filter(r => r === 'v8').length + (f.reuseDecisions?.length ?? 0) - reuseFrom,
        nodeActions: runtimes.filter(r => r === 'node').length,
        readBytes: sum('readBytes'),
        writeBytes: sum('writeBytes'),
        r2ClassA: r2.a,
        r2ClassB: r2.b,
        r2BytesPut: r2.bytesPut,
      };
    },
  };
}
async function run(f, m, task) {
  m.tasks.push(task.name);
  await f.execute(task);
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
const landed = f =>
  [...f.tables.projectHostedLandingRequests.values()].filter(r => JSON.parse(r.value).phase === 'landed')
    .length;

/** One `land --save` through server compose, check and acceptance; `moveMain` moves main during the
 * check, so it recomposes on a source job and checks again (the common dogfood case). */
async function solo(t, { moveMain = false, extraQuery = false } = {}) {
  const f = await finishFixture(t);
  const m = meter(f);
  const state = await f.enqueue(f.request());
  if (extraQuery) {
    // The seeded regression: one more query per landing (a status read on the landing path).
    assert(finishApi.status.isQuery);
    await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  }
  await drain(f, m);
  for (let round = 0; round < (moveMain ? 2 : 1); round++) {
    if (moveMain && round === 0) f.moveMain();
    await f.passChecks();
    await drain(f, m);
  }
  assert.equal(landed(f), 1);
  return { landings: 1, checkRuns: runs(f).length, stamped: stamped(f), ...(await m.stop()) };
}
/** Four queued landings composed and checked together under the default batching policy. */
async function batch(t, { extraQuery = false } = {}) {
  const f = await batchesFixture(t, { count: 0, batching: 'default', batchMaxSize: null });
  const entries = [];
  for (let i = 0; i < 4; i++) entries.push(await f.add(i));
  // Measured from enqueue on: the Candidates were composed at save, as a queued landing's are.
  const m = meter(f);
  if (extraQuery)
    for (const state of entries)
      await f.tx('extraStatus', finishApi.status, { projectId: f.projectId, submissionId: state.id });
  for (let steps = 0; ; steps++) {
    assert(steps < 400, 'finite batch work');
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
    const queued = f.runs().filter(r => r.status === 'queued');
    for (const r of queued) await f.rawChecks.pass(await f.rawChecks.activate(r.id));
    // Event-driven work first; a stall alarm only when nothing else can move.
    const task =
      f.pending().find(x => !x.name.startsWith('projectHostedLandingStall')) ??
      (queued.length ? null : f.pending()[0]);
    if (task) await run(f, m, task);
    else if (!queued.length) break;
  }
  assert.equal(landed(f), 4);
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
