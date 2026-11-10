// SPDX-License-Identifier: Apache-2.0
// Speed budgets (b7851c44, regression ladder rung 1): a landing's own time to main and check minutes
// are judged against src/speed-budgets.json over the last window of landings, on data the landing
// already wrote. A break alerts once and opens one P0 Issue; a recovery closes the alert.
// Replays the B1.5d n3-r3 a1 slowdown (4432 s against a ~1500 s norm).
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { readFileSync } from 'node:fs';
import {
  addAuditSeconds,
  carriedCostCounts,
  longestStage,
  landingSpeedSample,
  observeLandingSpeed,
  speedBudgetIssue,
  speedBudgetMessage,
  speedBudgetsSchema,
  windowValue,
} from '../dist/landing-speed-alerts.js';
import { speedBudgets as budgets } from '../dist/speed-budgets.js';
import { formatSpeedBudgets, speedBudgetRows, speedBudgetWarning } from '../dist/speed-budgets-report.js';

const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const speedApi = await import(moduleUrl('../convex/projectLandingSpeed.ts'));
const { retainCheckProgress } = await import(moduleUrl('../convex/projectHostedLandingCheckProgress.ts'));
const { presign, r2Counts } = await import(moduleUrl('../convex/presign.ts'));
const minute = 60_000,
  noon = Date.parse('2026-11-04T12:00:00.000Z');
const byId = id => budgets.budgets.find(b => b.id === id);
const WINDOW = budgets.window.landings;
let n = 0;
/** Replays landings one minute apart; returns the final state and every event raised, in order. */
function landings(state, values, start = noon + n * minute) {
  const events = [];
  for (const [index, [toMain, check = 5, settle = 8.5]] of values.entries()) {
    const out = observeLandingSpeed(
      state,
      {
        at: start + index * minute,
        id: `r${n++}`.padEnd(8, '0'),
        toMain,
        check,
        settle,
        stages: { queue: toMain - check - 1, check, settle: settle / 60 },
      },
      budgets,
    );
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}
const normal = (count, toMain = 12, check = 6) => Array.from({ length: count }, () => [toMain, check]);

test('incident replay n3-r3 a1: three slow landings in a day alert once on time to main, naming the next step', () => {
  let { state } = landings(null, normal(WINDOW));
  // n3-r3 a1: 4432 s (74 min) against the normal ~1500 s (25 min) pace; here against a 12 min norm.
  const first = landings(state, [[74]]);
  const second = landings(first.state, [[74]]);
  assert.deepEqual(
    [...first.events, ...second.events],
    [],
    'one or two slow landings are outliers, not a window',
  );
  const third = landings(second.state, [[74]]);
  assert.equal(third.events.length, 1);
  const [event] = third.events;
  assert.equal(event.kind, 'broken');
  assert.equal(event.budget.id, 'land-to-main-p90');
  assert.equal(event.value, 74);
  assert.equal(event.landing, `r${n - 1}`.padEnd(8, '0'), 'names the landing that crossed it');
  assert.match(event.stage, /^queue and compose \(\d+ min\)$/);
  assert.deepEqual(Object.keys(third.state.broken), ['land-to-main-p90']);
  const message = speedBudgetMessage(event, 'forge', budgets);
  assert.match(message.subject, /^\[Forge\] Speed budget broken: landing to main p90: forge$/);
  assert.match(message.text, /is 74 min; budget 60 min/);
  assert.match(message.text, /Crossed by landing r\d+0* /);
  assert.match(message.text, /\nNext: run `nforge metrics ROOT --text`/);
  // While it stays broken: no second alert, however many slow landings follow.
  const more = landings(third.state, normal(5, 90));
  assert.deepEqual(more.events, []);
  // Recovery: one message when the window is back within the budget, then silence.
  const recovered = landings(more.state, normal(WINDOW));
  assert.deepEqual(
    recovered.events.map(e => [e.kind, e.budget.id]),
    [['recovered', 'land-to-main-p90']],
  );
  assert.deepEqual(recovered.state.broken, {});
  assert.deepEqual(landings(recovered.state, normal(3)).events, []);
});

test('a single outlier, normal noise and a project with fewer landings than the window never alert', () => {
  let { state, events } = landings(null, [...normal(WINDOW - 1), [500, 6]]);
  assert.deepEqual(events, [], 'one 500 min outlier among a full window stays under the p90 budget');
  ({ state, events } = landings(state, normal(WINDOW, 24, 9.9)));
  assert.deepEqual(events, [], 'just under the p50 budgets never breaks');
  // A cold project: fewer landings than the window have no verdict, however slow.
  const cold = landings(null, normal(WINDOW - 1, 500, 500));
  assert.deepEqual(cold.events, []);
  assert.equal(windowValue(cold.state.samples, 'toMain', 'p50', WINDOW), null);
});

test('time to main and check minutes break their own budgets; unknown stamps are skipped, not counted as zero', () => {
  const slowMedian = Math.floor(WINDOW / 2) + 1;
  let { state, events } = landings(null, normal(WINDOW - slowMedian));
  const slow = landings(state, normal(slowMedian, 70, 15));
  const ids = slow.events.map(e => e.budget.id).sort();
  assert.deepEqual(ids, ['check-p50', 'check-p90', 'land-to-main-p50', 'land-to-main-p90']);
  assert.deepEqual(events, []);
  // Landings with no check stamp (a reused check) leave check unknown: they neither break nor mask it.
  const gaps = observeLandingSpeed(
    slow.state,
    {
      at: noon + 999 * minute,
      id: 'gap00000',
      toMain: 5,
      check: null,
      stages: { queue: 4, check: null, settle: 1 },
    },
    budgets,
  );
  assert.equal(gaps.state.samples.at(-1)[2], null);
  assert.equal(windowValue(gaps.state.samples, 'check', 'p50', WINDOW), 15, 'window skips the unknown stamp');
});

test('incident replay 03a749a5: a check-result-to-commit gap of 300 s breaks the 30 s budget; the fixed 8.5 s never does', () => {
  const fixed = landings(null, normal(WINDOW));
  assert.deepEqual(fixed.events, [], 'the live 8.5 s gap is within budget');
  assert.equal(windowValue(fixed.state.samples, 'settle', 'p90', WINDOW), 8.5);
  // Before caa934a7 every landing waited about 300 s after its check: three of them break the p90.
  const two = landings(fixed.state, [
    [12, 6, 300],
    [12, 6, 300],
  ]);
  assert.deepEqual(two.events, [], 'two stalled landings are outliers');
  const three = landings(two.state, [[12, 6, 300]]);
  assert.deepEqual(
    three.events.map(e => [e.kind, e.budget.id, e.value, e.budget.unit]),
    [['broken', 'check-to-commit-p90', 300, 's']],
  );
  assert.match(speedBudgetMessage(three.events[0], 'forge', budgets).text, /is 300 s; budget 30 s/);
  assert.deepEqual(
    landings(three.state, normal(WINDOW)).events.map(e => e.kind),
    ['recovered'],
  );
  assert.equal(
    windowValue([[1, 1, 1, 'old00000']], 'settle', 'p90', 1),
    null,
    'rows from before the stamp have no verdict',
  );
});

test('the row stays small: samples are capped and each carries a short landing id and its counts', () => {
  let state = null;
  for (let i = 0; i < 200; i++)
    state = observeLandingSpeed(
      state,
      {
        at: noon + i * minute,
        id: `s${i}`.padEnd(36, '0'),
        toMain: 16.1,
        check: 8.3,
        settle: 8.5,
        attempts: 2,
        writes: 12,
        counts: [12, 36, 1_500_000, 3264, 282, 1128],
        stages: { queue: 5, check: 8.3, settle: 0.1 },
      },
      budgets,
    ).state;
  assert.equal(state.samples.length, 40);
  assert(Buffer.byteLength(JSON.stringify(state)) < 5_000, 'row stays small');
});

test('samples come from the landed state only; missing stamps leave a metric unknown', () => {
  const state = {
    id: '11111111-1111-4111-8111-111111111111',
    acceptance: { receiptId: '22222222-2222-4222-8222-222222222222' },
    timing: {
      submittedAt: '2026-11-04T10:00:00.000Z',
      checkReservedAt: '2026-11-04T10:05:00.000Z',
      ciEndedAt: '2026-11-04T10:08:30.000Z',
      committedAt: '2026-11-04T10:12:00.000Z',
    },
  };
  assert.deepEqual(landingSpeedSample(state), {
    at: Date.parse('2026-11-04T10:12:00.000Z'),
    id: '22222222-2222-4222-8222-222222222222',
    toMain: 12,
    check: 3.5,
    settle: 210,
    saveMs: null,
    preflightMs: null,
    attempts: null,
    writes: null,
    // Nothing reported a count: unknown, except the audit slot, which starts at 0 and only grows.
    counts: [null, null, null, null, null, 0],
    stages: { queue: 5, check: 3.5, settle: 3.5 },
  });
  // Cost counts: the accepted attempt's ordinal from the caller, the writes from the state's version.
  assert.deepEqual(
    [
      landingSpeedSample({ ...state, version: 6 }, 2).attempts,
      landingSpeedSample({ ...state, version: 6 }).writes,
    ],
    [2, 7],
  );
  const noCheck = landingSpeedSample({ ...state, timing: { ...state.timing, ciEndedAt: undefined } });
  assert.equal(noCheck.check, null);
  assert.equal(longestStage(noCheck.stages), 'queue and compose (5 min)');
  assert.equal(landingSpeedSample({}), null);
});

test('one P0 Issue per budget: the same id on every break and recovery, reopened only on a break', () => {
  const project = '33333333-3333-4333-8333-333333333333';
  const broken = (landing, kind = 'broken') => ({
    kind,
    budget: byId('land-to-main-p90'),
    value: 74,
    landing,
    since: '2026-11-04T12:00:00.000Z',
    stage: 'check (9 min)',
  });
  const first = speedBudgetIssue(broken('aaaaaaaa'), project, budgets);
  const again = speedBudgetIssue(broken('bbbbbbbb'), project, budgets);
  const recovered = speedBudgetIssue(broken('aaaaaaaa', 'recovered'), project, budgets);
  const other = speedBudgetIssue({ ...broken('aaaaaaaa'), budget: byId('check-p50') }, project, budgets);
  assert.equal(again.itemId, first.itemId, 'a repeat break finds the same Issue, never a duplicate');
  assert.equal(recovered.itemId, first.itemId);
  assert.notEqual(other.itemId, first.itemId, 'each budget has its own Issue');
  assert.notEqual(
    speedBudgetIssue(broken('aaaaaaaa'), '44444444-4444-4444-8444-444444444444', budgets).itemId,
    first.itemId,
  );
  assert.equal(
    new Set([first.putOperationId, again.putOperationId, first.commentOperationId, recovered.putOperationId])
      .size,
    4,
  );
  assert.equal(
    speedBudgetIssue(broken('aaaaaaaa'), project, budgets).putOperationId,
    first.putOperationId,
    'a retried write reconciles',
  );
  assert.deepEqual([first.reopen, recovered.reopen], [true, false]);
  assert.match(first.title, /^P0 speed budget broken: landing to main p90/);
  assert.match(first.body, /landing `aaaaaaaa`/);
  assert.match(recovered.comment, /back within budget/);
});

test('the budget file: every budget names its source and reason, only unrecorded ones lack a number, idle calls are 0', () => {
  const file = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url), 'utf8'));
  const parsed = speedBudgetsSchema.parse(file);
  const ids = parsed.budgets.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const b of parsed.budgets) {
    assert.equal(
      b.max === null,
      b.measuredBy === 'unrecorded',
      `${b.id}: a number unless nothing records the value`,
    );
    assert(b.source.length > 20 && b.reason.length > 20, `${b.id}: source and reason are stated`);
  }
  assert.equal(byId('idle-convex-calls').max, 0);
  // The cost ledger (Issue 3e3f9fe6): each per-landing quantity names its value, source and decision.
  const costIds = parsed.costs.map(c => c.id);
  assert.equal(new Set(costIds).size, costIds.length);
  for (const unit of ['calls', 'bytes', 'GB-s', 'ops', 'runs', 'uploads', 'min'])
    assert(
      parsed.costs.some(c => c.unit === unit),
      `a ${unit} cost is budgeted`,
    );
  for (const id of ['landing-attempts-mean', 'landing-writes-mean'])
    assert(byId(id).issue, `${id} names its decision`);
  for (const id of [
    'save',
    'preflight',
    'cli-cold-start',
    'web-first-paint',
    'check-p50',
    'land-to-main-p50',
    'land-to-main-p90',
  ])
    assert(byId(id), `${id} is budgeted`);
  assert.throws(
    () => speedBudgetsSchema.parse({ ...file, window: { landings: 1 } }),
    'one outlier must not decide',
  );
});

test('the metrics report shows each value against its budget: pass, fail, unrun when the data or the measurer is missing, guarded by the build', () => {
  const period = { from: '2026-11-03T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' };
  const at = index => new Date(Date.parse(period.from) + index * 3_600_000).toISOString();
  const records = {
    // 20 landings: 14 fast, 6 slow, so the median holds and the p90 (18th) is slow.
    finishTimings: Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      at: at(i),
      trusted: true,
      minutes: i < 14 ? 10 : 80,
    })),
    runs: Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      at: at(i),
      status: 'passed',
      wallMinutes: 8,
      inputs: [],
    })),
  };
  const rows = speedBudgetRows(records, period, budgets);
  const row = id => rows.find(r => r.id === id);
  assert.deepEqual([row('land-to-main-p50').status, row('land-to-main-p50').value], ['pass', 10]);
  assert.deepEqual([row('land-to-main-p90').status, row('land-to-main-p90').value], ['fail', 80]);
  assert.deepEqual([row('check-p50').status, row('check-p90').status], ['pass', 'pass']);
  assert.equal(row('cli-cold-start').status, 'unrun');
  assert.equal(row('save').status, 'unrun');
  assert.equal(row('idle-convex-calls').status, 'guarded');
  assert.match(speedBudgetWarning(rows), /^speed budget broken: land-to-main-p90 80\/60 min$/);
  assert.match(formatSpeedBudgets(rows).join('\n'), /fail\s+land-to-main-p90: 80 \/ 60 min/);
  // Fewer landings than the window: unrun, never a pass.
  const few = speedBudgetRows(
    { finishTimings: records.finishTimings.slice(0, 5), runs: [] },
    period,
    budgets,
  );
  assert.equal(few.find(r => r.id === 'land-to-main-p50').status, 'unrun');
  assert.equal(speedBudgetWarning(few), null);
});

test('live cost drift: a recompose loop breaks the attempts mean once and recovers; rows from before the counts have no verdict', () => {
  const cost = (attempts, writes = attempts * 7) =>
    Array.from({ length: WINDOW }, (_, i) => ({ attempts, writes, i }));
  let state = null;
  const feed = rows => {
    const events = [];
    for (const row of rows) {
      const out = observeLandingSpeed(
        state,
        {
          at: noon + n * minute,
          id: `c${n++}`.padEnd(8, '0'),
          toMain: 12,
          check: 6,
          settle: 8.5,
          attempts: row.attempts,
          writes: row.writes,
          stages: { queue: 5, check: 6, settle: 0.1 },
        },
        budgets,
      );
      state = out.state;
      events.push(...out.events);
    }
    return events;
  };
  // Normal dogfood: about 2.3 attempts per landing (2026-11-08 to 11-10), no verdict change.
  assert.deepEqual(feed(cost(2)), []);
  assert.equal(windowValue(state.samples, 'attempts', 'mean', WINDOW), 2);
  // One starved landing (incident 10d253c6: 10 land operations) is an outlier in the mean.
  assert.deepEqual(feed([{ attempts: 10, writes: 70 }]), []);
  // A loop on every landing breaks attempts and writes once each, then stays quiet.
  const broke = feed(cost(6));
  assert.deepEqual(broke.map(e => [e.kind, e.budget.id]).sort(), [
    ['broken', 'landing-attempts-mean'],
    ['broken', 'landing-writes-mean'],
  ]);
  const attempts = broke.find(e => e.budget.id === 'landing-attempts-mean');
  const message = speedBudgetMessage(attempts, 'forge', budgets);
  assert.match(
    message.text,
    /attempts per landing mean over the last 20 landings is \S+ attempts; budget 4 attempts/,
  );
  assert.match(message.text, /recomposeCount and checkRunIds/);
  assert.match(speedBudgetIssue(attempts, 'p', budgets).body, /Decision it protects: Issue 51bbbd00/);
  assert.deepEqual(feed(cost(6)), []);
  assert.deepEqual(
    feed(cost(2)).map(e => e.kind),
    ['recovered', 'recovered'],
  );
  // A row from before the counts (five fields) parses and has no cost verdict.
  assert.equal(windowValue([[1, 12, 6, 'old00000', 8.5]], 'attempts', 'mean', 1), null);
});

test('live cost counts: R2 requests and runner minutes are stamped on the landing, carried across attempts and judged as means', () => {
  // The signing seam counts by class: reads and heads are B, writes and listings A, deletes nothing.
  const signed = {
    host: 'h.invalid',
    path: '/b/k',
    accessKeyId: 'a',
    secretAccessKey: 's',
  };
  const before = r2Counts();
  return Promise.all([
    presign({ ...signed, method: 'GET' }),
    presign({ ...signed, method: 'HEAD' }),
    presign({ ...signed, method: 'PUT', headers: { 'content-length': '1500' } }),
    presign({ ...signed, method: 'GET', query: { 'list-type': '2' } }),
    presign({ ...signed, method: 'DELETE' }),
  ]).then(() => {
    const after = r2Counts();
    assert.deepEqual([after.a - before.a, after.b - before.b, after.put - before.put], [2, 2, 1500]);

    // A check run that ended reports its shard seconds; a running or unreported one leaves them unknown.
    const state = { at: '2026-11-04T10:00:00.000Z' };
    const run = {
      id: 'r',
      status: 'passed',
      counts: {},
      planDigest: null,
      executionId: null,
      terminalDigest: null,
      endedAt: '2026-11-04T10:08:00.000Z',
      at: state.at,
    };
    retainCheckProgress(state, { ...run, execution: { seconds: 3039.8, shards: 12 } }, noon);
    assert.equal(state.counts.runnerSeconds, 3040);
    const open = { at: state.at };
    retainCheckProgress(
      open,
      { ...run, status: 'running', endedAt: null, execution: { seconds: 5, shards: 1 } },
      noon,
    );
    retainCheckProgress(open, { ...run, execution: undefined }, noon);
    assert.equal(open.counts, undefined, 'an unreported run is unknown, not zero');

    // A recompose adds its compose's requests and discards the earlier run; a reused check keeps its run.
    const first = { r2: [2, 7, 1000], runnerSeconds: 3000 };
    assert.deepEqual(carriedCostCounts(first, [1, 4, 500], false), {
      r2: [3, 11, 1500],
      discardedRunnerSeconds: 3000,
    });
    assert.deepEqual(carriedCostCounts({ ...first, discardedRunnerSeconds: 60 }, undefined, true), {
      r2: [2, 7, 1000],
      runnerSeconds: 3000,
      discardedRunnerSeconds: 60,
    });
    assert.equal(carriedCostCounts(undefined, undefined, false), undefined);

    // The sample reads the state's counts; the audit seconds join the newest landing once.
    const landed = {
      id: '11111111-1111-4111-8111-111111111111',
      acceptance: { receiptId: '22222222-2222-4222-8222-222222222222' },
      version: 11,
      timing: { submittedAt: '2026-11-04T10:00:00.000Z', committedAt: '2026-11-04T10:12:00.000Z' },
      counts: { r2: [3, 11, 1500], runnerSeconds: 3000, discardedRunnerSeconds: 120 },
    };
    const sample = landingSpeedSample(landed, 2);
    assert.deepEqual(sample.counts, [3, 11, 1500, 3000, 120, 0]);
    let row = observeLandingSpeed(null, sample, budgets).state;
    row = addAuditSeconds(row, 1100);
    assert.equal(row.samples[0][7][5], 1100);
    assert.equal(
      addAuditSeconds({ ...row, samples: [] }, 1100).samples.length,
      0,
      'no landing, nothing to join',
    );

    // Means over the window, runner seconds read as minutes; an unstamped row is skipped, never zero.
    let rows = { samples: [], broken: {} };
    const feed = counts => {
      const out = observeLandingSpeed(
        rows,
        {
          ...sample,
          at: noon + n++ * minute,
          id: `k${n}`.padEnd(8, '0'),
          counts,
        },
        budgets,
      );
      rows = out.state;
      return out.events;
    };
    // The ledger is ratcheted from real data; the fixture must exercise below/above today's limits.
    const classA = Math.floor(byId('landing-r2-class-a-mean').max),
      classB = Math.floor(byId('landing-r2-class-b-mean').max / 2),
      bytesPut = Math.floor(byId('landing-r2-bytes-put-mean').max / 2),
      excessiveB = Math.ceil(byId('landing-r2-class-b-mean').max + 1);
    for (let i = 0; i < WINDOW; i++) assert.deepEqual(feed([classA, classB, bytesPut, 3260, 280, 1120]), []);
    assert.equal(windowValue(rows.samples, 'runnerAccepted', 'mean', WINDOW), 54.3);
    assert.equal(windowValue(rows.samples, 'runnerDiscarded', 'mean', WINDOW), 4.7);
    assert.equal(windowValue(rows.samples, 'runnerAudit', 'mean', WINDOW), 18.7);
    assert.equal(windowValue(rows.samples, 'r2ClassB', 'mean', WINDOW), classB);
    assert.equal(
      windowValue([[1, 12, 6, 'old00000', 8.5, 1, 7]], 'r2ClassA', 'mean', 1),
      null,
      'rows from before the counts have no verdict',
    );
    // A compose that re-reads every object (class B) and a test set that doubles each break their own
    // budget once, naming the next step, and stay quiet after.
    const broke = [];
    for (let i = 0; i < WINDOW; i++) broke.push(...feed([classA, excessiveB, bytesPut, 7000, 280, 1120]));
    assert.deepEqual(broke.map(e => [e.kind, e.budget.id]).sort(), [
      ['broken', 'landing-r2-class-b-mean'],
      ['broken', 'landing-runner-accepted-mean'],
    ]);
    const r2 = broke.find(e => e.budget.id === 'landing-r2-class-b-mean');
    assert.match(
      speedBudgetMessage(r2, 'forge', budgets).text,
      /R2 class B requests per landing mean over the last 20 landings is \S+ ops; budget \S+ ops/,
    );
    assert(
      speedBudgetMessage(r2, 'forge', budgets).text.includes(
        `budget ${byId('landing-r2-class-b-mean').max} ops`,
      ),
    );
    assert.match(speedBudgetMessage(r2, 'forge', budgets).text, /forge-source-step/);
    assert.match(speedBudgetIssue(r2, 'p', budgets).body, /Decision it protects: Issue ac5200f5/);
    assert.deepEqual(feed([classA, excessiveB, bytesPut, 7000, 280, 1120]), []);
  });
});

/** Seeds today's slow landings and the baseline relative to the landing's own clock. */
async function seededLanding(t, stallAlerts) {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...(policy ?? policyPreset('trusted')),
      agentDefaults: { stallAlerts, preflight: 'advise' },
    },
  });
  // Committed stamps use the wall clock (new Date()), not the fixture's fake Date.now.
  const wall = new Date().getTime();
  // Three slow landings just before this one: whatever it takes, the p90 of the last 20 is over 60 min.
  const seed = landings(null, normal(WINDOW - 4)).state;
  seed.samples = seed.samples.map(([at, ...rest]) => [at - noon + wall - 3_600_000, ...rest]);
  seed.samples.push(
    [wall - 3, 120, 3, 'seed0001'],
    [wall - 2, 120, 3, 'seed0002'],
    [wall - 1, 120, 3, 'seed0003'],
  );
  await f.tx('seedLandingSpeed', {
    _handler: ctx =>
      ctx.db.insert('projectLandingSpeed', { projectId: f.projectId, value: JSON.stringify(seed) }),
  });
  const before = f.counts.length;
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = [...f.tables.projectHostedLandingRequests.values()].map(row => JSON.parse(row.value));
  assert.deepEqual(
    landed.map(s => s.phase),
    ['landed'],
  );
  return { f, before };
}

test('a landing that breaks a budget alerts once on the stall-alert channel and queues one Issue write, with no idle work', async t => {
  const { f, before } = await seededLanding(t, { enabled: true, webhook: 'ntfy' });
  // The fixture's fake clock also jumps past the stall-alert tiers; those have their own tests.
  const deliveries = f.metrics.stallDeliveries.filter(d => /Speed budget/.test(d.subject));
  assert.equal(deliveries.length, 1, 'one alert, on the existing delivery action');
  assert.match(deliveries[0].subject, /^\[Forge\] Speed budget broken: landing to main p90: /);
  assert.match(deliveries[0].text, /Next: /);
  assert.equal(JSON.parse(deliveries[0].settings).webhook, 'ntfy');
  const [row] = f.tables.projectLandingSpeed.values();
  const stored = JSON.parse(row.value);
  assert.equal(stored.samples.length, WINDOW);
  assert.deepEqual(Object.keys(stored.broken), ['land-to-main-p90']);
  // Live cost counts ride in the same row write: one attempt, the landing state's seven writes.
  // (Found by its receipt id: the fixture's clock can place it before the seeded samples.)
  assert.deepEqual(stored.samples.find(sample => sample[3].length === 36).slice(5, 7), [1, 7]);
  // The Issue write: one scheduled action as the project owner, carrying the fixed per-budget Issue id.
  assert.equal(f.metrics.speedIssueWrites.length, 1);
  const [write] = f.metrics.speedIssueWrites;
  assert.equal(write.projectId, f.projectId);
  assert.equal(typeof write.owner, 'string');
  const issue = JSON.parse(write.issue);
  assert.equal(issue.reopen, true);
  assert.match(issue.title, /^P0 speed budget broken: landing to main p90/);
  assert(!f.counts.slice(before).some(c => /landingSpeed/i.test(c.name)), 'no new Convex call on a landing');
  assert.equal(f.pending().length, 0, 'idle afterwards: nothing left scheduled');
});

test('alerts off: the sample is kept and the Issue is still written, nothing is sent to the owner channels', async t => {
  const { f } = await seededLanding(t, { enabled: false });
  assert.equal(f.metrics.stallDeliveries.length, 0, 'no delivery of any kind');
  assert.equal(f.metrics.speedIssueWrites.length, 1, 'the board is the durable record');
  const [row] = f.tables.projectLandingSpeed.values();
  assert.equal(JSON.parse(row.value).samples.length, WINDOW);
});

test('the operator drill breaks one budget through the real path, then recovers it, then restores the window', async t => {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...(policy ?? policyPreset('trusted')),
      agentDefaults: { stallAlerts: { enabled: true, webhook: 'ntfy' } },
    },
  });
  const run = async (mode, original) => {
    let result;
    await f.tx('drill', {
      _handler: async ctx =>
        (result = await speedApi.drill._handler(ctx, { projectId: f.projectId, mode, original })),
    });
    await f.drain();
    return result;
  };
  const broke = JSON.parse(await run('break'));
  assert.deepEqual(broke.events, ['broken land-to-main-p90 70'], 'only the p90 budget breaks, not the p50');
  assert.equal(broke.original, null, 'a project with no row has nothing to restore');
  assert.equal(f.metrics.stallDeliveries.filter(d => /Speed budget broken/.test(d.subject)).length, 1);
  assert.deepEqual(
    f.metrics.speedIssueWrites.map(w => JSON.parse(w.issue).reopen),
    [true],
  );
  const recovered = JSON.parse(await run('recover'));
  assert.deepEqual(recovered.events, ['recovered land-to-main-p90 10']);
  assert.equal(f.metrics.stallDeliveries.filter(d => /Speed budget recovered/.test(d.subject)).length, 1);
  assert.deepEqual(
    f.metrics.speedIssueWrites.map(w => JSON.parse(w.issue).reopen),
    [true, false],
  );
  assert.equal(new Set(f.metrics.speedIssueWrites.map(w => JSON.parse(w.issue).itemId)).size, 1, 'one Issue');
  assert.equal(await run('restore'), 'restored');
  assert.equal([...f.tables.projectLandingSpeed.values()].length, 0, 'the synthetic window is gone');
});

for (const id of ['save', 'preflight']) {
  test(`${id} duration breaks once, recovers once and reopens the same P0 Issue after another break`, () => {
    const budget = byId(id);
    let state = null,
      tick = 0;
    const feed = (value, count = WINDOW) => {
      const events = [];
      for (let i = 0; i < count; i++) {
        const out = observeLandingSpeed(
          state,
          {
            at: noon + tick++ * minute,
            id: `duration-${tick}`,
            toMain: 10,
            check: 5,
            settle: 1,
            [budget.metric]: value,
            stages: { queue: 4, check: 5, settle: 1 },
          },
          budgets,
        );
        state = out.state;
        events.push(...out.events);
      }
      return events;
    };
    assert.deepEqual(feed(null), [], 'unknown durations do not train a window');
    assert.deepEqual(feed(budget.max / 2), []);
    assert.deepEqual(feed(budget.max * 2, 2), [], 'two outliers do not break p90');
    const [broken] = feed(budget.max * 2, 1);
    assert.equal(broken.budget.id, id);
    assert.equal(broken.kind, 'broken');
    assert.deepEqual(feed(budget.max * 2), [], 'no repeated alert while broken');
    const [recovered] = feed(budget.max / 2);
    assert.equal(recovered.kind, 'recovered');
    assert.deepEqual(feed(budget.max / 2), [], 'no repeated recovery');
    const [again] = feed(budget.max * 2);
    const issue = event => speedBudgetIssue(event, 'synthetic-project', budgets);
    assert.equal(issue(broken).itemId, issue(recovered).itemId);
    assert.equal(issue(broken).itemId, issue(again).itemId);
    assert.match(speedBudgetMessage(broken, 'synthetic', budgets).text, /Next: compare/);
    assert.equal(
      windowValue(addAuditSeconds(state, 60).samples, budget.metric, 'p90', WINDOW),
      budget.max * 2,
      'audit updates retain duration stamps',
    );
    const records = {
      finishTimings: state.samples.map(row => ({
        id: row[3],
        at: new Date(row[0]).toISOString(),
        minutes: row[1],
        [budget.metric]: row[id === 'save' ? 8 : 9],
      })),
      runs: [],
    };
    const rows = speedBudgetRows(
      records,
      { from: new Date(noon).toISOString(), to: new Date(noon + tick * minute).toISOString() },
      budgets,
    );
    assert.equal(rows.find(row => row.id === id).status, 'fail');
    assert.match(speedBudgetWarning(rows), new RegExp(id));
  });
}
