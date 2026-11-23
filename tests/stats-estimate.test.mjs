// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats method (Item a61d3c91, analyst comment 438310e0, review 1240fe03; docs/run-evidence.md#stats). Guards, with
// every expected number worked out by hand from the timeline in the comments, never by calling the replay:
// - Forge's side is every check run started that day (audits apart), and runs that did not land are split by why;
//   runs no landing attempt names are "unlinked", never "superseded".
// - Solo full checks price the GitHub side, including runs of a project that sets no gate (fullSuite null).
// - The merge queue: each change runs its pull-request check first; a change's own failed check fails that run and
//   never joins; a failed recheck after main moved is ejected and restarts the builds behind it, which count only the
//   share of a check they ran; the backlog carries into the next day slot by slot, each sensitivity on its own.
// - Work that did not land costs the same on both sides, at its recorded minutes.
// - Days closed by the first method stay readable, leave the CI figures, and say why there is no comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_COMPARE_MIN_LANDINGS,
  rerunsWhileWaiting,
  statsCarry,
  statsDay,
  statsDaySchema,
  statsWindow,
  firstTry,
} from '../dist/stats-estimate.js';
import { classifyRuns, mergeQueueReplay } from '../dist/stats-runs.js';

const min = 60_000;
const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);
const landing = (id, submitted, landed, extra = {}) => ({
  id,
  who: 'agent/a',
  submittedAt: submitted * min,
  landedAt: landed * min,
  checkStartedAt: (submitted + 1) * min,
  checkEndedAt: (submitted + 1) * min + 300_000,
  runnerSeconds: 240,
  discardedRunnerSeconds: 0,
  attempts: 1,
  ranInFull: true,
  ...extra,
});
const run = (id, at, status, seconds, extra = {}) => ({
  id,
  at: at * min,
  endedAt: status === 'running' ? null : at * min + 600_000,
  status,
  runnerSeconds: seconds,
  fullSuite: true,
  scopedRecheck: false,
  audit: false,
  ...extra,
});
const attempt = (id, submissionId, runId, extra = {}) => ({
  id,
  submissionId,
  parentAttemptId: null,
  runId,
  member: false,
  mainRace: false,
  ...extra,
});

test('overlapping landings: each landing that reached main while another waited is one rerun when branches must be up to date', () => {
  const day = [landing('a', 0, 5), landing('b', 1, 6), landing('c', 2, 7)];
  assert.deepEqual(rerunsWhileWaiting(day), [0, 1, 2]);
});

test('merge queue replay, worked by hand: concurrency, ejection, restarts priced by their share, cross-midnight slots', () => {
  const W = 300; // a passing build: 5 min
  const at = m => m * min;
  // One at a time: builds 0-5, 5-10, 10-15; joined at 0, 1, 2 min.
  assert.deepEqual(
    mergeQueueReplay(
      [
        { at: 0, fails: false },
        { at: at(1), fails: false },
        { at: at(2), fails: false },
      ],
      W,
      1,
    ).toMainSeconds,
    [300, 540, 780],
  );
  // 5 at once: each builds on arrival on top of those ahead; three full builds.
  const five = mergeQueueReplay(
    [
      { at: 0, fails: false },
      { at: at(1), fails: false },
      { at: at(2), fails: false },
    ],
    W,
    5,
  );
  assert.deepEqual(five.toMainSeconds, [300, 300, 300]);
  assert.equal(five.builds, 3);
  // A failing entry with no recorded time takes a full build: builds 0-5 (A), 1-6 (F), 2-7 (B). F is ejected at 6;
  // B had run 4 of its 5 minutes (0.8 of a build), restarts 6-11 and merges at 11: 9 min after it joined.
  const failing = mergeQueueReplay(
    [
      { at: 0, fails: false },
      { at: at(1), fails: true },
      { at: at(2), fails: false },
    ],
    W,
    5,
  );
  assert.deepEqual(failing.toMainSeconds, [300, 540]);
  near(failing.builds, 1 + 1 + 0.8 + 1, 'the cut-short build counts 0.8');
  // A failure that takes its own 1 min: F builds 1-2, B joined at 1.5 builds 1.5-2 (0.1 of a build), is cut at 2,
  // restarts 2-7 and merges at 7: 5.5 min after it joined.
  const fast = mergeQueueReplay(
    [
      { at: 0, fails: false },
      { at: at(1), fails: true, seconds: 60 },
      { at: at(1.5), fails: false },
    ],
    W,
    5,
  );
  assert.deepEqual(fast.toMainSeconds, [300, 330]);
  near(fast.builds, 1 + 0.2 + 0.1 + 1, 'a fast failure and the restart count their shares');
  // `from`: a change that first ran its pull-request check (5 min) joins at 5 and merges at 10: 10 min from "land".
  assert.deepEqual(mergeQueueReplay([{ at: at(5), from: 0, fails: false }], W, 5).toMainSeconds, [600]);
  // A finished build behind a slower head merges with the head, not before it.
  assert.deepEqual(
    mergeQueueReplay(
      [
        { at: 0, fails: false },
        { at: 0, fails: false },
      ],
      W,
      2,
    ).toMainSeconds,
    [300, 300],
  );
  // Across midnight: the previous day's last two entries merge at 10 and 12 min and hold both slots of a queue
  // building 2 at once until then. An entry joining at 9 builds from 10, when one slot frees, and merges at 15:
  // 6 min. One joining at 11 builds at once (the slot freed at 10) and merges at 16: 5 min, not 6 (frozen slots).
  assert.deepEqual(
    mergeQueueReplay([{ at: at(9), fails: false }], W, 2, [at(10), at(12)]).toMainSeconds,
    [360],
  );
  const carried = mergeQueueReplay([{ at: at(11), fails: false }], W, 2, [at(10), at(12)]);
  assert.deepEqual(carried.toMainSeconds, [300]);
  assert.deepEqual(carried.tail, [at(12), at(16)], 'the last two merge times carry on');
  assert.deepEqual(mergeQueueReplay([], W, 5, [at(3)]), { toMainSeconds: [], builds: 0, tail: [at(3)] });
});

test('merge queue replay edges: a failure that took no time, and carried slots that merge once', () => {
  const W = 300;
  const at = m => m * min;
  // Two at once: A and X build 0-5 and merge at 5. F (failed in under a second) and C start at 5; F is ejected at
  // once, so C loses nothing and merges at 10. Three full builds, not a phantom restart at 10 and a merge at 15.
  const zero = mergeQueueReplay(
    [
      { at: 0, fails: false },
      { at: 0, fails: false },
      { at: 0, fails: true, seconds: 0 },
      { at: 0, fails: false },
    ],
    W,
    2,
  );
  assert.deepEqual(zero.toMainSeconds, [300, 300, 600]);
  near(zero.builds, 3, 'no restart for a failure that took no time');
  // The previous day's slots merged at 10 and 12 min; a failure joins at 13, builds 13-14 and is ejected. Nothing
  // merged this day, so the tail is still 10 and 12, each once.
  const failedOnly = mergeQueueReplay([{ at: at(13), fails: true, seconds: 60 }], W, 2, [at(10), at(12)]);
  assert.deepEqual(failedOnly.tail, [at(10), at(12)]);
  near(failedOnly.builds, 0.2, 'the failure counts its share');
});

test('every run of a day, by what became of it; solo full checks alone price the GitHub side', () => {
  const runs = [
    run('accepted', 0, 'passed', 600),
    run('nogate', 0.5, 'passed', 610, { fullSuite: null }),
    run('contract', 0.7, 'passed', 50, { fullSuite: false }),
    run('batch', 1, 'passed', 300),
    run('failed', 2, 'failed', 120),
    run('passedThenMoved', 2.2, 'passed', 200),
    run('recheckFailed', 2.5, 'failed', 90),
    run('cancelled', 3, 'cancelled', null),
    run('cutForRecheck', 3.5, 'cancelled', 30),
    run('moved', 4, 'passed', 500),
    run('replaced', 5, 'passed', 400),
    run('waiting', 6, 'passed', 450),
    run('running', 7, 'running', null),
    run('audit', 8, 'passed', 900, { audit: true }),
    run('scoped', 9, 'passed', 100, { scopedRecheck: true }),
    run('byHand', 10, 'passed', 700),
    run('unread', 11, 'passed', 650),
  ];
  const attempts = [
    attempt('a1', 's1', 'accepted'),
    attempt('n1', 's11', 'nogate'),
    attempt('k1', 's12', 'contract'),
    attempt('b1', 's2', 'batch', { member: true }),
    attempt('b2', 's3', 'batch', { member: true }),
    attempt('f1', 's4', 'failed'),
    attempt('q0', 's13', 'passedThenMoved'),
    attempt('q1', 's13', 'recheckFailed', { parentAttemptId: 'q0', mainRace: true }),
    attempt('c1', 's5', 'cancelled'),
    attempt('x1', 's14', 'cutForRecheck'),
    attempt('x2', 's14', null, { parentAttemptId: 'x1' }),
    attempt('m1', 's6', 'moved'),
    attempt('m2', 's6', null, { parentAttemptId: 'm1' }),
    attempt('r1', 's7', 'replaced'),
    attempt('w1', 's8', 'waiting'),
    attempt('y1', 's9', 'running'),
    attempt('sc', 's10', 'scoped'),
    attempt('u1', 's15', 'unread'),
  ];
  const c = classifyRuns({
    runs,
    attempts,
    landedAttemptIds: new Set(['a1', 'n1', 'k1', 'b1', 'b2', 'sc']),
    pendingSubmissionIds: new Set(['s8']),
    unreadSubmissionIds: new Set(['s15']),
  });
  // 16 change runs: 600+610+50+300+120+200+90+30+500+400+450+100+700+650 = 4,800 s; two without minutes.
  assert.deepEqual(c.all, { runs: 16, seconds: 4800, unknown: 2 }, 'audits apart');
  assert.deepEqual(c.audits, { runs: 1, seconds: 900, unknown: 0 });
  assert.deepEqual(c.accepted, { runs: 5, seconds: 1660, unknown: 0 });
  assert.deepEqual(c.discarded.failed, { runs: 2, seconds: 210, unknown: 0 });
  assert.deepEqual(
    c.failedInQueue,
    { runs: 1, seconds: 90, unknown: 0 },
    'only the recheck fails in a queue',
  );
  assert.deepEqual(c.queueFailures, [{ at: 2.5 * min, seconds: 600 }]);
  assert.deepEqual(c.discarded.cancelled, { runs: 1, seconds: 0, unknown: 1 });
  assert.deepEqual(
    c.discarded.mainMoved,
    { runs: 3, seconds: 730, unknown: 0 },
    'cut short for a recheck too',
  );
  assert.deepEqual(c.discarded.superseded, { runs: 1, seconds: 400, unknown: 0 });
  assert.deepEqual(c.pending, { runs: 2, seconds: 450, unknown: 1 });
  assert.deepEqual(c.unlinked, { runs: 2, seconds: 1350, unknown: 0 }, 'no attempt, or its landing not read');
  assert.deepEqual(c.unknownRuns, [['cancelled', 'cancelled']], 'a late report finds its tally');
  // Solo: one change, the whole command (a full gate, or no gate at all), passed, minutes known. The batch, the
  // contract gate, the scoped recheck and the run no attempt names are not; the unread one is a solo check.
  assert.deepEqual(c.solo.runnerSeconds, [200, 400, 450, 500, 600, 610, 650]);
  assert.equal(c.partial, false);
});

test('a failed child attempt fails in a merge queue only when it rechecked for main moving after a pass', () => {
  const runs = [
    // Joined a batch (a child attempt before any check), and the batch failed: a pull-request failure.
    run('batchFailed', 1, 'failed', 100),
    // Fell back from that batch to its own check, main having moved meanwhile, and failed again: still never passed.
    run('fallbackFailed', 2, 'failed', 110),
    // A running first check stopped for main moving, then the recheck failed: never passed.
    run('stopped', 1, 'cancelled', 20),
    run('stoppedRecheckFailed', 2, 'failed', 120),
    // Passed, then a refresh on the same main failed: no main race.
    run('refreshBase', 1, 'passed', 300),
    run('refreshFailed', 2, 'failed', 130),
    // A recheck for main moving that failed before the submission's first pass.
    run('raceBeforePass', 1, 'failed', 140),
    run('passAfter', 3, 'passed', 300),
    // Passed, main moved, the recheck failed: ejected from a GitHub merge queue.
    run('passed', 1, 'passed', 300),
    run('raceFailed', 2, 'failed', 150),
    // A mixed batch (review d6b0f1aa finding 2): M passed and was recomposed for main moving into a batch with Y,
    // which never passed, and the batch failed. On GitHub Y fails its own pull-request check and M merges: no ejection.
    run('mPassed', 1, 'passed', 300),
    run('mixedFailed', 2, 'failed', 160),
  ];
  const attempts = [
    attempt('j0', 'sJ', null),
    attempt('j1', 'sJ', 'batchFailed', { parentAttemptId: 'j0', member: true }),
    attempt('j2', 'sJ', 'fallbackFailed', { parentAttemptId: 'j1', mainRace: true }),
    attempt('t0', 'sT', 'stopped'),
    attempt('t1', 'sT', null, { parentAttemptId: 't0' }),
    attempt('t2', 'sT', 'stoppedRecheckFailed', { parentAttemptId: 't1', mainRace: true }),
    attempt('e0', 'sE', 'refreshBase'),
    attempt('e1', 'sE', 'refreshFailed', { parentAttemptId: 'e0' }),
    attempt('g0', 'sG', null),
    attempt('g1', 'sG', 'raceBeforePass', { parentAttemptId: 'g0', mainRace: true }),
    attempt('g2', 'sG', 'passAfter', { parentAttemptId: 'g1' }),
    attempt('p0', 'sP', 'passed'),
    attempt('p1', 'sP', 'raceFailed', { parentAttemptId: 'p0', mainRace: true }),
    attempt('m0', 'sM', 'mPassed'),
    attempt('m1', 'sM', 'mixedFailed', { parentAttemptId: 'm0', mainRace: true, member: true }),
    attempt('y0', 'sY', 'mixedFailed', { member: true }),
  ];
  const c = classifyRuns({
    runs,
    attempts,
    landedAttemptIds: new Set(),
    pendingSubmissionIds: new Set(['sG']),
  });
  assert.deepEqual(c.discarded.failed, { runs: 7, seconds: 910, unknown: 0 });
  assert.deepEqual(
    c.failedInQueue,
    { runs: 1, seconds: 150, unknown: 0 },
    'the mixed batch is not an ejection',
  );
  assert.deepEqual(c.queueFailures, [{ at: 2 * min, seconds: 600 }]);
});

test('one first-try rule: no resubmission and no discarded check', () => {
  assert.equal(firstTry({ resubmitted: false, discardedCheck: false, known: true }), 1);
  assert.equal(firstTry({ resubmitted: true, discardedCheck: false, known: true }), 2);
  assert.equal(firstTry({ resubmitted: false, discardedCheck: true, known: false }), 2);
  assert.equal(firstTry({ resubmitted: false, discardedCheck: false, known: false }), null);
});

/** Two closed days, every figure worked by hand. Minutes count from 2026-11-10 00:00 UTC; a solo full check takes
 * 10 min and 3,000 runner s.
 * Day 0, 52 landings:
 * - P0..P47: sent at 30 + 20i, landed 12 min later, each with its own solo full run (even i: a project with no gate).
 *   One at a time: builds s..s+10, 10 min. Queue: pull-request check s..s+10, queue build s+10..s+20, 20 min.
 * - B (batch member): sent 1000, landed 1045, its share of a passed batch run 1,000 s; the other member still waits.
 * - S: sent 1040, its solo run (3,000 s) passed, main moved, a scoped recheck (400 s) landed it at 1056. B reached
 *   main while S waited: one rerun.
 * - Q: sent 1082, landed 1110, solo run 3,000 s. A recheck of other work after main moved failed at 1091 after
 *   4 min (1,200 s; its first check, 3,000 s, was discarded). In the queue Q joins at 1092, the failure builds
 *   1091-1095 and is ejected; Q had run 3 of 10 min, restarts 1095-1105: 23 min. Builds 0.4 + 0.3 + 1.
 * - Late: sent 1432, landed 1439, run 3,000 s. One at a time it merges at 1442 (past midnight); the queue at 1452.
 * - Not landed: a change's own failed check (500 s), a passed contract-gate run replaced later (800 s), a cancelled
 *   run with no minutes, a passed run no attempt names (700 s), a passed run waiting to land (3,000 s), an audit.
 * Day 1: N sent at 1441, landed 1453, solo run 3,200 s. One at a time the late entry holds the slot until 1442:
 * 11 min. In the queue N joins at 1451 beside the carried entry (merging 1452) and merges at 1461: 20 min.
 */
function fixture() {
  const runs = [],
    attempts = [],
    landings = [],
    landed = new Set();
  const solo = (id, sent, landedAt, runAt, seconds, extra = {}) => {
    landings.push(landing(id, sent, landedAt));
    runs.push(run(`r-${id}`, runAt, 'passed', seconds, extra));
    attempts.push(attempt(`a-${id}`, `s-${id}`, `r-${id}`));
    landed.add(`a-${id}`);
  };
  for (let i = 0; i < 48; i++) {
    const s = 30 + 20 * i;
    solo(`P${i}`, s, s + 12, s + 1, 3000, i % 2 ? {} : { fullSuite: null });
  }
  landings.push(landing('B', 1000, 1045));
  runs.push(run('r-batch', 1001, 'passed', 1000));
  attempts.push(
    attempt('a-B', 's-B', 'r-batch', { member: true }),
    attempt('a-X', 's-X', 'r-batch', { member: true }),
  );
  landed.add('a-B');
  landings.push(landing('S', 1040, 1056));
  runs.push(run('r-S0', 1041, 'passed', 3000), run('r-S1', 1052, 'passed', 400, { scopedRecheck: true }));
  attempts.push(attempt('a-S0', 's-S', 'r-S0'), attempt('a-S1', 's-S', 'r-S1', { parentAttemptId: 'a-S0' }));
  landed.add('a-S1');
  solo('Q', 1082, 1110, 1083, 3000);
  runs.push(run('r-F0', 1080, 'passed', 3000), {
    ...run('r-F1', 1091, 'failed', 1200),
    endedAt: 1095 * min,
  });
  attempts.push(
    attempt('a-F0', 's-F', 'r-F0'),
    attempt('a-F1', 's-F', 'r-F1', { parentAttemptId: 'a-F0', mainRace: true }),
  );
  solo('Late', 1432, 1439, 1428, 3000);
  runs.push(
    { ...run('r-G', 1200, 'failed', 500), endedAt: 1202 * min },
    run('r-H', 1210, 'passed', 800, { fullSuite: false }),
    run('r-C', 1230, 'cancelled', null),
    run('r-U', 1240, 'passed', 700),
    run('r-P', 1300, 'passed', 3000),
    run('r-A', 1250, 'passed', 900, { audit: true }),
  );
  attempts.push(attempt('a-G', 's-G', 'r-G'), attempt('a-H', 's-H', 'r-H'), attempt('a-C', 's-C', 'r-C'));
  attempts.push(attempt('a-P', 's-P', 'r-P'));
  const day0 = classifyRuns({
    runs,
    attempts,
    landedAttemptIds: landed,
    pendingSubmissionIds: new Set(['s-X', 's-P']),
  });
  const day1 = classifyRuns({
    runs: [run('r-N', 1442, 'passed', 3200)],
    attempts: [attempt('a-N', 's-N', 'r-N')],
    landedAttemptIds: new Set(['a-N']),
    pendingSubmissionIds: new Set(),
  });
  return { day0: { landings, runs: day0 }, day1: { landings: [landing('N', 1441, 1453)], runs: day1 } };
}

test('the replayed merge queue builds at the project’s own width and the window names it (Item 3678767e)', () => {
  const { day0 } = fixture();
  const at5 = statsDay('2026-11-10', day0.landings, day0.runs, statsCarry(null));
  const at1 = statsDay('2026-11-10', day0.landings, day0.runs, statsCarry(null), 1);
  assert.equal(
    at5.replay.width,
    undefined,
    'width 5 is what days closed before it was kept replayed: nothing stored',
  );
  assert.equal(at1.replay.width, 1);
  // Width 1 is still a merge queue: every change runs its pull-request check (600 s) before it joins, so none reaches
  // main sooner than that check plus its own build (1,200 s).
  assert.ok(Math.min(...at1.replay.mergeQueue) >= 1200, 'a width-one queue keeps the pull-request check');
  assert.deepEqual(statsWindow([at1]).comparison.mergeQueue.widths, [1]);
  assert.deepEqual(statsWindow([at5]).comparison.mergeQueue.widths, [5], 'days without a stored width say 5');
  assert.deepEqual(
    statsWindow([at5, at1]).comparison.mergeQueue.widths,
    [1, 5],
    'a setting changed inside the period lists every width it used',
  );
});

test('fixture: every Stats figure recomputed by hand from raw rows, across midnight', () => {
  const { day0, day1 } = fixture();
  const d0 = statsDaySchema.parse(
    JSON.parse(JSON.stringify(statsDay('2026-11-10', day0.landings, day0.runs, statsCarry(null)))),
  );
  const d1 = statsDaySchema.parse(
    JSON.parse(JSON.stringify(statsDay('2026-11-11', day1.landings, day1.runs, statsCarry(d0)))),
  );
  // Day 0's replays.
  assert.equal(d0.replay.wallSeconds, 600);
  assert.deepEqual(d0.replay.oneAtATime, Array(52).fill(600));
  assert.deepEqual(d0.replay.mergeQueue, [...Array(51).fill(1200), 1380]);
  near(d0.replay.builds, 48 + 1 + 1 + (0.4 + 0.3 + 1) + 1, 'day 0 queue builds');
  assert.equal(d0.replay.failed, 1);
  assert.equal(d0.replay.reruns, 1);
  assert.deepEqual(d0.replay.tails.one, [1442 * min]);
  assert.deepEqual(
    d0.replay.tails.queue,
    [990, 1020, 1060, 1105, 1452].map(m => m * min),
    'the last five merges: P47, B, S, Q, Late',
  );
  // Sensitivity, each carried on its own. 9 min checks: P47 988, B 1018, S 1058, Q 1100 (it builds 1091-1100 ahead of
  // the 3.6 min failure), Late 1450. 11 min: the 4.4 min failure is ejected at 1095.4 and Q restarts to 1106.4.
  assert.deepEqual(
    d0.replay.tails.fast,
    [988, 1018, 1058, 1100, 1450].map(m => m * min),
  );
  assert.deepEqual(
    d0.replay.tails.slow,
    [992, 1022, 1062, 1106.4, 1454].map(m => Math.round(m * min)),
  );
  assert.deepEqual(d0.replay.mergeQueueFast, Array(52).fill(1080));
  assert.deepEqual(d0.replay.mergeQueueSlow, [...Array(51).fill(1320), 1464]);
  // Day 1: the backlog across midnight, slot by slot.
  assert.deepEqual(d1.replay.oneAtATime, [660]);
  assert.deepEqual(d1.replay.mergeQueue, [1200]);
  assert.deepEqual(d1.replay.mergeQueueFast, [1080]);
  assert.deepEqual(d1.replay.mergeQueueSlow, [1320]);
  assert.equal(d1.replay.builds, 1);

  const w = statsWindow([d0, d1]);
  // Forge: 61 change runs. Day 0: 48 x 3,000 + 1,000 + 3,000 + 400 + 3,000 + 3,000 + 1,200 + 3,000 + 500 + 800 + 700
  // + 3,000 = 163,600 s; day 1: 3,200 s. 166,800 s = 2,780 min, over 53 landings.
  assert.equal(w.measured.runs, 61);
  assert.equal(w.measured.unknownRuns, 1);
  assert.equal(w.measured.ciMinutes, 2780);
  assert.equal(w.measured.ciMinutesPerLanding, 2780 / 53);
  assert.deepEqual(w.measured.unlinked, { runs: 1, minutes: 700 / 60, unknown: 0 });
  assert.deepEqual(w.measured.discarded.byCause, {
    mainMoved: { runs: 2, minutes: 100, unknown: 0 },
    failed: { runs: 2, minutes: 1700 / 60, unknown: 0 },
    cancelled: { runs: 1, minutes: 0, unknown: 1 },
    superseded: { runs: 1, minutes: 800 / 60, unknown: 0 },
  });
  const c = w.comparison;
  assert.ok(c, `53 landings >= ${STATS_COMPARE_MIN_LANDINGS}`);
  assert.equal(w.compare.gap, null);
  assert.equal(c.check.runnerSeconds, 3000, 'median of 54 solo runs: 53 at 3,000 s and one at 3,200 s');
  assert.equal(c.check.runs, 54, '51 accepted solo runs, two discarded solo checks and the waiting one');
  assert.equal(c.forgeMinutes, 2780);
  assert.deepEqual(c.failed, { inQueue: 1, pullRequest: 1 });
  assert.deepEqual(c.notLanded, { runs: 2, minutes: 800 / 60 });
  // One at a time: (53 changes + 1 rerun) x 3,000 s, plus failed checks (1,700 s) and work that did not land (800 s).
  assert.equal(c.oneAtATime.runs, 54);
  assert.equal(c.oneAtATime.recordedRuns, 4);
  near(c.oneAtATime.ciMinutes, (54 * 3000 + 2500) / 60, 'one at a time CI');
  near(c.oneAtATime.savedMinutes, (54 * 3000 + 2500) / 60 - 2780, 'Forge used 38.3 min more');
  // Merge queue: (53 pull-request runs + 53.7 builds) x 3,000 s, plus the change's own failed check (500 s) and work
  // that did not land (800 s). The failed recheck is inside the builds.
  near(c.mergeQueue.runs, 53 + 53.7, 'merge queue runs');
  assert.equal(c.mergeQueue.recordedRuns, 3);
  near(c.mergeQueue.ciMinutes, (106.7 * 3000 + 1300) / 60, 'merge queue CI');
  assert.equal(c.mergeQueue.maxToMerge, 1);
  // Time to main. Forge: 49 at 720 s, B 2,700, S 960, Q 1,680, Late 420: median 720.
  assert.equal(c.forgeToMainSeconds, 720);
  assert.equal(c.oneAtATime.toMainSeconds, 600);
  assert.equal(c.oneAtATime.sooner, -120);
  assert.equal(c.mergeQueue.toMainSeconds, 1200);
  assert.equal(c.mergeQueue.sooner, 480);
  assert.deepEqual(c.mergeQueue.sensitivity, { fast: 1080, slow: 1320 });
  // Load: (53 + 1) arrivals x 600 s over two days.
  assert.equal(c.load, (54 * 600) / (2 * 86_400));
  assert.equal(w.daysWithoutRuns, 0);
  assert.equal(w.daysWithoutSolo, 0);
});

test('a day closed by the first method stays readable, leaves the CI figures, and says why there is no comparison', () => {
  const v1 = {
    schema: 1,
    day: '2026-11-09',
    landings: 60,
    partial: false,
    runner: { priced: 60, unknown: 0, acceptedSeconds: 600, discardedSeconds: 0 },
    firstTry: { counted: 60, first: 40 },
    toMain: [60, 120, 180],
    stops: { queue: [], check: [], land: [] },
    replay: {
      fullCheck: { runnerSeconds: 200, wallSeconds: 60, basis: 'full', runs: 3 },
      runs: 6,
      reruns: 0,
      runnerSeconds: { low: 1200, high: 1200 },
      toMain: [60],
      freeAt: 0,
    },
    who: [['agent/a', 60, 40, 60]],
    others: 0,
  };
  const parsed = statsDaySchema.parse(v1);
  assert.equal(parsed.schema, 1);
  const w = statsWindow([parsed]);
  assert.equal(w.comparison, null);
  assert.deepEqual(
    w.compare,
    { gap: 'not-recorded', toGo: 0 },
    '60 landings, none recorded: never "0 to go"',
  );
  assert.equal(w.measured.ciMinutes, null, 'not recorded, never 0');
  assert.equal(w.measured.discarded, null);
  assert.equal(w.measured.firstTryRate, 40 / 60);
  assert.deepEqual(statsCarry(parsed), statsCarry(null), 'a first-method day hands nothing on');
  const noRuns = statsDay('2026-11-10', [landing('x', 0, 5)]);
  assert.equal(noRuns.ci, null, 'no runs read: no CI figures, never zero');
  assert.deepEqual(statsWindow([noRuns]).compare, { gap: 'landings', toGo: STATS_COMPARE_MIN_LANDINGS });
  // Runs read but no solo full check anywhere: no price for a GitHub run.
  const busy = Array.from({ length: 50 }, (_, i) => landing(`b${i}`, i, i + 5));
  const unpriced = statsDay(
    '2026-11-11',
    busy,
    classifyRuns({
      runs: [run('scoped', 1, 'passed', 100, { scopedRecheck: true })],
      attempts: [attempt('sa', 'ss', 'scoped')],
      landedAttemptIds: new Set(['sa']),
      pendingSubmissionIds: new Set(),
    }),
  );
  const none = statsWindow([unpriced]);
  assert.deepEqual([none.compare.gap, none.daysWithoutSolo], ['no-solo', 1]);
  // Mixed: a recorded day with too few landings beside 60 unrecorded ones: not recorded, not "landings to go".
  const mixed = statsWindow([parsed, noRuns]);
  assert.equal(mixed.compare.gap, 'not-recorded');
  assert.equal(mixed.daysWithoutRuns, 2);
});
