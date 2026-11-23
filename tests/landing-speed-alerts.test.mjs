// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Speed budgets (b7851c44, regression ladder rung 1): a landing's own time to main and check minutes
// are judged against src/speed-budgets.json over the last window of landings, on data the landing
// already wrote. A break alerts once and opens one P0 Issue; a recovery closes the alert.
// Replays the B1.5d n3-r3 a1 slowdown (4432 s against a ~1500 s norm).
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
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
    // From the accepted check's end: no first-ready stamp was passed (42200ce4).
    passToLand: 3.5,
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
    const classA = 1,
      classB = 1,
      bytesPut = Math.floor(byId('landing-r2-bytes-put-mean').max / 2),
      excessiveB = Math.ceil(byId('landing-r2-request-usd-mean').max / 0.36e-6) + 1;
    // Three of the twenty landings threw a check away (about 4.7 runner minutes a landing, 3 checks).
    for (let i = 0; i < WINDOW; i++)
      assert.deepEqual(feed([classA, classB, bytesPut, 3260, i < 3 ? 1880 : 0, 1120]), []);
    assert.equal(windowValue(rows.samples, 'runnerAccepted', 'mean', WINDOW), 54.3);
    assert.equal(windowValue(rows.samples, 'runnerDiscarded', 'mean', WINDOW), 4.7);
    // Minutes stay as a secondary number; the budget judges checks (a landing with discarded seconds and
    // two attempts threw one check away).
    assert.equal(windowValue(rows.samples, 'discardedChecks', 'sum', WINDOW), 3);
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
    for (let i = 0; i < WINDOW; i++) broke.push(...feed([classA, excessiveB, bytesPut, 7000, 0, 1120]));
    assert.deepEqual(broke.map(e => [e.kind, e.budget.id]).sort(), [
      ['broken', 'landing-r2-request-usd-mean'],
      ['broken', 'landing-runner-accepted-mean'],
    ]);
    const r2 = broke.find(e => e.budget.id === 'landing-r2-request-usd-mean');
    assert.match(
      speedBudgetMessage(r2, 'forge', budgets).text,
      /R2 request dollars per landing mean over the last 20 landings is \S+ USD; budget \S+ USD/,
    );
    assert(
      speedBudgetMessage(r2, 'forge', budgets).text.includes(
        `budget ${byId('landing-r2-request-usd-mean').max} USD`,
      ),
    );
    assert.match(speedBudgetMessage(r2, 'forge', budgets).text, /forge-source-step/);
    assert.match(speedBudgetIssue(r2, 'p', budgets).body, /Decision it protects: Issue ac5200f5/);
    assert.deepEqual(feed([classA, excessiveB, bytesPut, 7000, 0, 1120]), []);
  });
});

test('R2 cost weights request classes, preserves fractional dollars and excludes either missing stamp', () => {
  const row = counts => [noon, 12, 6, 'priced00', 8.5, 1, 7, counts];
  const price = rows => windowValue(rows, 'r2RequestUsd', 'mean', rows.length);
  assert.equal(price([row([2, 0, 0, null, null, null])]), 0.000009);
  assert.equal(price([row([0, 25, 0, null, null, null])]), 0.000009);
  assert.equal(price([row([0, 1, 0, null, null, null])]), 0.00000036);
  assert.equal(price([row([0, 0, 999999, null, null, null])]), 0, 'body bytes are a separate budget');
  for (const counts of [
    [null, 1],
    [1, null],
    [null, null],
  ]) {
    const incomplete = row([...counts, 0, null, null, null]);
    assert.equal(price([incomplete]), null);
    assert.equal(price([row([2, 0, 0, null, null, null]), incomplete]), null);
  }
});

test('one weighted R2 break creates one stable P0, stays quiet and recovers without the retired alerts', () => {
  const budget = { ...byId('landing-r2-request-usd-mean'), max: 0.000018 };
  const config = { ...budgets, budgets: [budget], window: { landings: 5 } };
  let state = {
    schema: 2,
    samples: [],
    broken: {
      'landing-r2-class-a-mean': { since: new Date(noon).toISOString(), landing: 'old00000', value: 99 },
      'landing-r2-class-b-mean': { since: new Date(noon).toISOString(), landing: 'old00000', value: 99 },
    },
  };
  let tick = 0;
  const feed = (a, b) => {
    const out = observeLandingSpeed(
      state,
      {
        at: noon + tick++ * minute,
        id: `price${tick}`,
        toMain: 12,
        check: 6,
        settle: 8.5,
        counts: [a, b, 0, null, null, null],
        stages: { queue: 5, check: 6, settle: 1 },
      },
      config,
    );
    state = out.state;
    return out.events;
  };
  for (let i = 0; i < 5; i++) assert.deepEqual(feed(3, 12), []);
  assert.deepEqual(state.broken, {}, 'retired request-count budgets leave no stale broken state');
  assert.equal(windowValue(state.samples, 'r2RequestUsd', 'mean', 5), 0.00001782);
  const events = [];
  for (let i = 0; i < 5; i++) events.push(...feed(3, 13));
  assert.equal(events.length, 1, 'a sub-microdollar crossing is not rounded to zero');
  assert.equal(events[0].kind, 'broken');
  assert.equal(events[0].budget.id, budget.id);
  assert.deepEqual(feed(3, 13), []);
  const first = speedBudgetIssue(events[0], 'project', config);
  const recovery = [];
  for (let i = 0; i < 5; i++) recovery.push(...feed(0, 0));
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].kind, 'recovered');
  assert.equal(speedBudgetIssue(recovery[0], 'project', config).itemId, first.itemId);
  assert.deepEqual(feed(0, 0), []);
});

/** Seeds today's slow landings and the baseline relative to the landing's own clock. */
async function seededLanding(t, stallAlerts) {
  storageClock(t);
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...(policy ?? policyPreset('trusted')),
      agentDefaults: { stallAlerts, preflight: 'advise' },
    },
  });
  const seededAt = Date.now();
  // Three slow landings just before this one: whatever it takes, the p90 of the last 20 is over 60 min.
  const seed = landings(null, normal(WINDOW - 4)).state;
  seed.samples = seed.samples.map(([at, ...rest]) => [at - noon + seededAt - 3_600_000, ...rest]);
  // The waste tripwire's open day was built at the replay's dates; the shifted seed has no day of its own.
  delete seed.waste;
  seed.samples.push(
    [seededAt - 3, 120, 3, 'seed0001'],
    [seededAt - 2, 120, 3, 'seed0002'],
    [seededAt - 1, 120, 3, 'seed0003'],
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

test('incident f5c45985: discarded operation stamp survives a missing accepted-run stamp and joins the alert window', async () => {
  const { landingCosts } = await import('../dist/hosted-landings-view.js');
  const state = {
    id: 'synthetic',
    version: 10,
    timing: { submittedAt: '2026-11-04T10:00:00.000Z', committedAt: '2026-11-04T10:12:00.000Z' },
    counts: carriedCostCounts({ runnerSeconds: 3317 }, undefined, false),
  };
  const sample = landingSpeedSample(state, 2);
  assert.equal(sample.counts[3], null);
  assert.equal(sample.counts[4], 3317);
  assert.equal(landingCosts(state, 1).runnerDiscarded, 3317 / 60);
  let history = null;
  const feed = counts =>
    (history = observeLandingSpeed(
      history,
      { ...sample, at: noon + n * minute, id: `sample-${n++}`, counts },
      budgets,
    ).state);
  for (let i = 0; i < WINDOW - 1; i++) feed([null, null, null, null, 600, null]);
  feed(sample.counts);
  assert.equal(
    windowValue(history.samples, 'runnerDiscarded', 'mean', WINDOW),
    Math.round((((WINDOW - 1) * 600 + 3317) / 60 / WINDOW) * 10) / 10,
  );
  // Each of these landings (two attempts, discarded seconds known) threw one check away.
  assert.equal(windowValue(history.samples, 'discardedChecks', 'sum', WINDOW), WINDOW);
  const unknown = landingSpeedSample({ ...state, counts: undefined });
  assert.equal(unknown.counts[4], null);
  feed(unknown.counts);
  const records = {
    finishTimings: history.samples.map(row => ({
      id: row[3],
      at: new Date(row[0]).toISOString(),
      minutes: row[1],
      costs: { runnerDiscarded: row[7][4] === null ? null : row[7][4] / 60 },
    })),
    runs: [],
  };
  const period = { from: new Date(noon).toISOString(), to: new Date(noon + (n + 1) * minute).toISOString() };
  const report = speedBudgetRows(records, period, budgets).find(
    b => b.id === 'landing-runner-discarded-mean',
  );
  assert.match(report.note, /1 newest landings have unknown stamps/);
  assert.equal(report.value, windowValue(history.samples, 'discardedChecks', 'sum', WINDOW));
  assert.equal(report.unit, 'checks');
  assert.match(report.note, /secondary: \S+ runner min of discarded checks per landing/);
  // A transition based on known samples names recent missing stamps instead of pretending they cost zero.
  const previous = { ...history, broken: {} };
  previous.samples = previous.samples.map(row => {
    const next = structuredClone(row);
    if (next[7][4] !== null) next[7][4] = 6000;
    return next;
  });
  const { events } = observeLandingSpeed(
    previous,
    { ...sample, at: noon + n++ * minute, id: 'crossing' },
    budgets,
  );
  const event = events.find(e => e.budget.metric === 'discardedChecks');
  assert.equal(event.unknown, 1);
  assert.match(
    speedBudgetMessage(event, 'synthetic', budgets).text,
    /unknown discarded runner seconds stamp; excluded, never counted as zero \(the sum reaches back/,
  );
});

test('Item 1018d0f8: the discarded budget counts thrown-away checks per window of landings (limit 4), minutes beside it', () => {
  const budget = byId('landing-runner-discarded-mean');
  assert.deepEqual(
    [budget.metric, budget.stat, budget.unit, budget.max],
    ['discardedChecks', 'sum', 'checks', 4],
    'four checks in 20 landings, the original intent of the 12-minute line',
  );
  assert.match(budget.source, /Unit changed from runner minutes to checks/);
  assert.match(budget.reason, /Four discarded checks in 20 landings/);
  // Per landing: no discarded seconds is none thrown away (a reused check is kept); unknown stays unknown.
  const checks = (attempts, seconds) =>
    windowValue(
      [[noon, 1, 1, 'c', 1, attempts, 1, [null, null, null, null, seconds, null]]],
      'discardedChecks',
      'sum',
      1,
    );
  assert.equal(checks(1, 0), 0);
  assert.equal(checks(3, 0), 0, 'attempts that reused their check threw nothing away');
  assert.equal(checks(2, 3000), 1);
  assert.equal(checks(4, 9000), 3);
  assert.equal(checks(1, 600), 1, "a batch member's share of a failed cohort run is one check");
  assert.equal(checks(null, 600), 1);
  assert.equal(checks(2, null), null, 'unknown seconds are excluded, never counted as zero');

  // Break and recover: a window of clean landings, then four discards are within the budget, the fifth breaks.
  let state = null,
    index = 0;
  const feed = (attempts, seconds) => {
    const out = observeLandingSpeed(
      state,
      {
        at: noon + 9_000 * minute + index * minute,
        id: `chk${index++}`.padEnd(8, '0'),
        toMain: 10,
        check: 5,
        settle: 8.5,
        attempts,
        writes: 8,
        counts: [1, 1, 1000, 3000, seconds, 1000],
        stages: { queue: 4, check: 5, settle: 0.1 },
      },
      budgets,
    );
    state = out.state;
    return out.events.filter(e => e.budget.id === budget.id);
  };
  for (let i = 0; i < WINDOW; i++) assert.deepEqual(feed(1, 0), []);
  for (let i = 0; i < 4; i++)
    assert.deepEqual(feed(2, 3000), [], `discard ${i + 1} of 4 is within the budget`);
  assert.equal(windowValue(state.samples, 'discardedChecks', 'sum', WINDOW), 4);
  const broke = feed(2, 3000);
  assert.deepEqual(
    broke.map(e => [e.kind, e.value, e.line]),
    [['broken', 5, 4]],
  );
  assert.equal(broke[0].minutes, 12.5, 'five checks of 50 runner-min in 20 landings, 12.5 min a landing');
  const message = speedBudgetMessage(broke[0], 'forge', budgets).text;
  assert.match(message, /discarded checks over the last 20 landings is 5 checks; budget 4 checks/);
  assert.match(message, /Secondary: 12.5 runner min of discarded checks per landing/);
  const issue = speedBudgetIssue(broke[0], 'p', budgets);
  assert.match(issue.title, /^P0 speed budget broken: discarded checks/);
  assert.match(issue.body, /discarded checks over the last 20 landings must stay at or under 4 checks\./);
  assert.deepEqual(feed(2, 3000), [], 'stays quiet while broken');
  // Clean landings push the discards out of the window; at four it recovers, once.
  const recovered = [];
  for (let i = 0; i < WINDOW; i++) recovered.push(...feed(1, 0));
  assert.deepEqual(
    recovered.map(e => [e.kind, e.value]),
    [['recovered', 4]],
  );
  assert.match(speedBudgetMessage(recovered[0], 'forge', budgets).text, /is 4 checks; budget 4 checks/);
  // A count budget never ratchets.
  assert.equal(state.ratchet?.[budget.id], undefined);
});

test('incident fa2c1383 economics: rechecks outlive the 40-landing window and a late usage correction, so the keep rule measures them', async t => {
  const { measuredCheckCosts } = await import('../dist/stale-check-economics.js');
  const { RECHECK_BASIS_SINCE, RECHECK_RESERVE, currentRecheckSample, landingSpeedStateSchema, speedWindow } =
    await import('../dist/landing-speed-alerts.js');
  // 53c9a388 (2026-11-23): a landing about every 13 min, so the 40-landing row covered 8.5 h and held
  // 2 rechecks; the keep rule needs 3, so every overlapping run cancelled `scoped-unmeasured`. Replay a
  // day and a half of it: a recheck every 18th landing (about one every 4 h), a whole check otherwise.
  const kindOf = i => (i % 18 === 9 ? 'scoped' : 'full');
  const landing = (i, start = RECHECK_BASIS_SINCE) => {
    const kind = kindOf(i),
      jobs = kind === 'full' ? 5500 : 2400;
    return {
      at: start + (i + 1) * 13 * minute,
      id: `econ${String(i).padStart(4, '0')}`,
      toMain: 20,
      check: kind === 'full' ? 12 : 6,
      settle: 30,
      attempts: 2,
      writes: 9,
      counts: [1, 1, 1, jobs, 0, 0, ...(kind === 'full' ? [jobs] : [])],
      passToLand: 3,
      kind,
      stages: { queue: 7, check: kind === 'full' ? 12 : 6, settle: 0.5 },
    };
  };
  let state = null,
    windowOnly = null;
  const events = [],
    windowEvents = [];
  for (let i = 0; i < 140; i++) {
    const out = observeLandingSpeed(state, landing(i), budgets);
    state = out.state;
    events.push(...out.events);
    // What the row did before the reserve: the window alone.
    const before = observeLandingSpeed(windowOnly, landing(i), budgets);
    windowOnly = { ...before.state, samples: speedWindow(before.state.samples) };
    windowEvents.push(...before.events);
  }
  const window = speedWindow(state.samples);
  assert.equal(window.filter(row => row[11] === 'scoped').length, 2, 'the window alone holds two rechecks');
  assert.equal(measuredCheckCosts(window), null, 'the incident: the window alone leaves the keep unmeasured');
  const reserve = state.samples.slice(0, -window.length);
  assert.equal(reserve.length, RECHECK_RESERVE);
  assert.ok(reserve.every(row => row[11] === 'scoped' && row[0] < window[0][0]));
  assert.deepEqual(measuredCheckCosts(state.samples), {
    wholeWallMinutes: 12,
    scopedShare: { jobs: 2400 / 5500, wall: 6 / 12 },
  });
  // Every budget judges the same window as before: same events, same window rows, same flags.
  assert.deepEqual(events, windowEvents);
  assert.deepEqual(window, windowOnly.samples);
  assert.deepEqual({ ...state, samples: window }, windowOnly);
  // Rollback: the row still parses on the unchanged schema, so a server without the reserve keeps the
  // window and drops the reserve at its next landing.
  assert.deepEqual(landingSpeedStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  assert.ok(
    JSON.stringify(state).length - JSON.stringify(windowOnly).length <= 600,
    'about 550 bytes more with 8-character ids (about 760 with receipt UUIDs)',
  );

  // Rechecks reserved before the selector narrowed (9e3ba8ba) measured a wider recheck: they never count.
  let old = null;
  for (let i = 0; i < 140; i++)
    old = observeLandingSpeed(old, landing(i, RECHECK_BASIS_SINCE - 150 * 13 * minute), budgets).state;
  assert.equal(old.samples.length, 40, 'no reserve from rechecks before the basis');
  assert.equal(measuredCheckCosts(old.samples), null);

  // A late usage correction re-observes the newest landing: it keeps its check kind and pass-to-land.
  const f = await finishFixture(t);
  const newest = window.at(-1);
  const recheckRow = [...newest.slice(0, 10), 3, 'scoped'];
  const stored = { ...state, samples: [...state.samples.slice(0, -1), recheckRow] };
  await f.tx('seedLandingSpeed', {
    _handler: ctx =>
      ctx.db.insert('projectLandingSpeed', { projectId: f.projectId, value: JSON.stringify(stored) }),
  });
  await f.tx('correct', {
    _handler: ctx =>
      speedApi.correctLandingRunnerCosts(ctx, f.projectId, [
        {
          phase: 'landed',
          acceptance: { receiptId: newest[3] },
          counts: { runnerSeconds: 2400, discardedRunnerSeconds: 700 },
        },
      ]),
  });
  const [row] = f.tables.projectLandingSpeed.values();
  const corrected = JSON.parse(row.value).samples;
  assert.equal(corrected.at(-1)[7][4], 700, 'the late usage joins the newest sample');
  assert.equal(corrected.at(-1)[10], 3, 'pass-to-land kept');
  assert.equal(corrected.at(-1)[11], 'scoped', 'check kind kept');
  assert.equal(corrected.length, state.samples.length, 'the reserve is kept, not duplicated');
  // Review finding 4: late usage for a reserve receipt writes nothing (economics reads accepted seconds).
  const before = row.value;
  await f.tx('correctReserve', {
    _handler: ctx =>
      speedApi.correctLandingRunnerCosts(ctx, f.projectId, [
        {
          phase: 'landed',
          acceptance: { receiptId: reserve[0][3] },
          counts: { discardedRunnerSeconds: 900 },
        },
      ]),
  });
  assert.equal([...f.tables.projectLandingSpeed.values()][0].value, before);

  // Review finding 1: rechecks the estimator cannot use (no check time) never evict usable ones.
  let mixed = null;
  const feed = (i, patch = {}) =>
    (mixed = observeLandingSpeed(
      mixed,
      { ...landing(i), id: `mix${String(i).padStart(4, '0')}`, ...patch },
      budgets,
    ).state);
  for (let i = 0; i < 3; i++) feed(i, { kind: 'scoped', check: 6, counts: [1, 1, 1, 2400, 0, 0] });
  for (let i = 3; i < 8; i++) feed(i, { kind: 'scoped', check: null, counts: [1, 1, 1, 2400, 0, 0] });
  for (let i = 8; i < 50; i++) feed(i, { kind: 'full', check: 12, counts: [1, 1, 1, 5500, 0, 0, 5500] });
  assert.equal(mixed.samples.length, 43, 'only the three usable rechecks are reserved');
  assert.deepEqual(measuredCheckCosts(mixed.samples)?.scopedShare, { jobs: 2400 / 5500, wall: 0.5 });

  // Review finding 2: a reservation within the rounding of the cutoff, or with no settle time, is before it.
  // Check time is stored rounded to a tenth of a minute, as `span` stores it.
  const edge = (reservedAt, checkSeconds, settle) => [
    reservedAt + checkSeconds * 1000 + (settle ?? 0) * 1000,
    10,
    Math.round((checkSeconds / 60) * 10) / 10,
    'edge0000',
    settle,
    1,
    1,
    [1, 1, 1, 2400, 0, 0],
    null,
    null,
    1,
    'scoped',
  ];
  assert.equal(currentRecheckSample(edge(RECHECK_BASIS_SINCE - 1000, 62, 30)), false, 'reserved 1 s before');
  assert.equal(currentRecheckSample(edge(RECHECK_BASIS_SINCE + 10_000, 58, 30)), true, 'reserved 10 s after');
  assert.equal(
    currentRecheckSample(edge(RECHECK_BASIS_SINCE + 3_600_000, 60, null)),
    false,
    'no settle time',
  );
});
