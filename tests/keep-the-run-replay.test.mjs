// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383): the recorded 11-17 window, where main moves threw running checks
// away, replayed through today's sweep and the keep rule (tests/keep-the-run-replay.mjs). Recorded
// queue waits are kept, so time to main moves only by the run wall the keep changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayKeepTheRun } from './keep-the-run-replay.mjs';

const drop = (before, after) => 1 - after / before;
const noRise = (baseline, keep) => {
  const at = JSON.stringify({ baseline, keep });
  assert(keep.runnerMinutes <= baseline.runnerMinutes, at);
  assert(keep.runWallMinutes <= baseline.runWallMinutes, at);
  assert(keep.timeToMainP50Minutes <= baseline.timeToMainP50Minutes, at);
  assert(keep.timeToMainMeanMinutes <= baseline.timeToMainMeanMinutes, at);
};

test('incident fa2c1383: keeping runs where it pays cuts the 11-17 main-move waste by 30% or more without raising runner-minutes, run wall or time to main', t => {
  const { calibration, reasons, outcomes, baseline, keep } = replayKeepTheRun();
  t.diagnostic(JSON.stringify({ calibration, reasons, outcomes, baseline, keep }));
  // Today's rule explains every recorded main-move cancel, so the baseline arm is the record.
  assert(calibration.mainMoveCancels >= 50, JSON.stringify(calibration));
  assert.equal(calibration.baselineAgrees, calibration.mainMoveCancels);
  // Lane A alone, recorded waits kept: measured 35.0% of job-minutes and 33.3% of wall.
  assert(
    drop(baseline.cancelledJobMinutes, keep.cancelledJobMinutes) >= 0.3,
    JSON.stringify({ baseline, keep }),
  );
  assert(
    drop(baseline.cancelledWallMinutes, keep.cancelledWallMinutes) >= 0.3,
    JSON.stringify({ baseline, keep }),
  );
  // Cancelled minutes can fall while total minutes rise (each kept pass that cannot carry pays a
  // scoped recheck): the total, the run wall and time to main must not rise either.
  noRise(baseline, keep);
});

test('incident fa2c1383: a scoped-recheck keep that does not pay retires as today', () => {
  const { reasons, outcomes } = replayKeepTheRun();
  // The payback condition refused runs kept before the review (13 at today's scoped share).
  assert(reasons['scoped-costs-more'] > 0, JSON.stringify(reasons));
  assert(outcomes['scoped-recheck'] > 0, JSON.stringify(outcomes));
  // Shared docs are taken as tested on a strict main: none carries for free.
  assert.equal(outcomes.carry ?? 0, 0, JSON.stringify(outcomes));
});

test('incident fa2c1383: the Item target of half needs Lane B and selector precision (5dcfce75)', t => {
  const arms = Object.fromEntries(
    Object.entries({
      laneA: {},
      laneB: { laneB: true },
      precision: { scopedScale: 0.5 },
      both: { laneB: true, scopedScale: 0.5 },
    }).map(([name, options]) => [name, replayKeepTheRun(undefined, options)]),
  );
  const { baseline } = arms.laneA;
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.keep]))));
  for (const arm of Object.values(arms)) noRise(baseline, arm.keep);
  const job = arm => drop(baseline.cancelledJobMinutes, arms[arm].keep.cancelledJobMinutes);
  // Each step only adds: Lane B 40.3%, precision 46.3%, both 61.5% of job-minutes.
  assert(job('laneB') > job('laneA') && job('precision') > job('laneA') && job('both') > job('laneB'));
  assert(job('laneB') < 0.5 && job('precision') < 0.5, 'neither step alone meets the target');
  assert(job('both') >= 0.5);
  assert(drop(baseline.cancelledWallMinutes, arms.both.keep.cancelledWallMinutes) >= 0.5);
});

test('incident fa2c1383 Lane B: a clean probe on every overlap, through the rule, cuts the waste by 40% or more', t => {
  const laneA = replayKeepTheRun();
  const laneB = replayKeepTheRun(undefined, { laneB: true });
  t.diagnostic(JSON.stringify({ reasons: laneB.reasons, outcomes: laneB.outcomes, keep: laneB.keep }));
  const { baseline } = laneB;
  // Measured: 2,977 -> 1,776 cancelled job-min (-40.3%), 420 -> 256 wall-min (-39.0%).
  assert(
    drop(baseline.cancelledJobMinutes, laneB.keep.cancelledJobMinutes) >= 0.4,
    JSON.stringify(laneB.keep),
  );
  assert(drop(baseline.cancelledWallMinutes, laneB.keep.cancelledWallMinutes) >= 0.38);
  noRise(baseline, laneB.keep);
  noRise(laneA.keep, laneB.keep);
  // Every overlap is decided by the rest of the rule (payback, scope, cohort, red main), never by
  // overlap alone; the window had no conflicting probe (every landing landed).
  assert.equal(laneB.reasons['code-overlap'] ?? 0, 0, JSON.stringify(laneB.reasons));
  assert.equal(laneB.reasons['compose-conflict'] ?? 0, 0);
  assert(laneA.reasons['code-overlap'] > 0);
  // The probe lifts only overlap retires: every other cause counts the same or more.
  for (const [reason, n] of Object.entries(laneA.reasons))
    if (reason !== 'code-overlap') assert((laneB.reasons[reason] ?? 0) >= n, reason);
  assert(laneB.outcomes['scoped-recheck'] > laneA.outcomes['scoped-recheck']);
});

test('fa2c1383 replay: coverage movers, red main and cohorts still retire their runs', () => {
  const { calibration, reasons } = replayKeepTheRun();
  // The window had all three; each must stay a cancel under the keep rule (687d1eda, main gate, cohorts).
  for (const reason of ['coverage-mover', 'main-red', 'cohort']) assert(reasons[reason] > 0, reason);
  assert.equal(calibration.redSpans, 3, 'main stays red across each failed audit until a green one');
  assert.equal(reasons.unrelated ?? 0, 0, 'a recorded cancel is never re-read as unrelated');
});

test('fa2c1383 replay: recorded non-run waits are kept; time to main moves only by the run wall', () => {
  const changedBy = {};
  for (const [arm, options] of [
    ['laneA', {}],
    ['laneB', { laneB: true }],
  ]) {
    const { rows } = replayKeepTheRun(undefined, options);
    let changed = 0;
    for (const [i, keep] of rows.keep.entries()) {
      const base = rows.baseline[i];
      if (keep === base) continue;
      changed++;
      const ttm = keep.timeToMainMinutes - base.timeToMainMinutes;
      const runWall = keep.runWallMinutes - base.runWallMinutes;
      assert(Math.abs(ttm - runWall) < 0.01, JSON.stringify({ arm, base, keep }));
    }
    changedBy[arm] = changed;
  }
  assert(changedBy.laneA > 0 && changedBy.laneB > changedBy.laneA, JSON.stringify(changedBy));
});

test('fa2c1383 Lane B replay: the window probes 6 kept runs, with no second-mover probe to price', () => {
  // Every probe is a first probe on a run kept to its end; the cost table floors second-mover
  // probes at the cascade rate anyway (tests/keep-the-run-scenarios.mjs probeOverhead).
  assert.deepEqual(replayKeepTheRun(undefined, { laneB: true }).probes, {
    first: 6,
    firstRetiredLater: 0,
    again: 0,
    stale: 0,
  });
  assert.equal(replayKeepTheRun().probes, undefined);
});

// A small synthetic trace for the model's own rules: full checks 800 s / 100 job-min, scoped
// rechecks 600 s / 70 job-min (shares 0.7 and 0.75).
const synthetic = ({ landings, runs }) => {
  const reference = [
    { id: 'ref-full', submittedAt: -5000, committedAt: -4000, paths: ['src/ref-a.ts'] },
    { id: 'ref-scoped', submittedAt: -3000, committedAt: -2000, paths: ['src/ref-b.ts'] },
  ];
  const all = [...reference, ...landings];
  const paths = [...new Set(all.flatMap(l => l.paths))];
  const run = (id, landing, startedAt, seconds, status, gate, billedMinutes = null) => ({
    id,
    landings: [landing],
    startedAt,
    endedAt: startedAt + seconds,
    status,
    gate,
    shards: 12,
    billedMinutes,
  });
  return {
    policy: {
      mode: 'auto-on-pass',
      landingMode: 'fast',
      hostedCrossHeadReuse: true,
      scopedRecheck: true,
      protectedPaths: ['.github/**'],
    },
    paths,
    landings: all.map(l => ({ ...l, paths: l.paths.map(path => paths.indexOf(path)) })),
    runs: [
      run('ref-1', 'ref-full', -4900, 800, 'passed', 'full', 100),
      run('ref-2', 'ref-scoped', -2700, 600, 'passed', 'scoped', 70),
      ...runs.map(r => run(...r)),
    ],
  };
};
// Landing x's first full run is cancelled by mover m1 (a sub-package manifest: carry), and its
// replacement passes. `later` lands while the kept run would still be running.
const carryThenLater = (laterPaths, { xPaths = ['src/x.ts'], laterAt = 700, auditFailed = false } = {}) =>
  synthetic({
    landings: [
      { id: 'm1', submittedAt: -800, committedAt: 100, paths: ['packages/p/package.json'] },
      { id: 'later', submittedAt: -100, committedAt: laterAt, paths: laterPaths, auditFailed },
      { id: 'x', submittedAt: 0, committedAt: 1000, paths: xPaths },
    ],
    runs: [
      ['m1-1', 'm1', -700, 800, 'passed', 'full', 100],
      ['later-1', 'later', -50, 700, 'passed', 'full', 100],
      ['x-1', 'x', 0, 102, 'cancelled', 'full'],
      ['x-2', 'x', 110, 800, 'passed', 'full', 100],
    ],
  });

test('fa2c1383 replay: a later mover that leaves only a scoped recheck downgrades a carry and pays it', () => {
  const unrelated = replayKeepTheRun(carryThenLater(['src/y.ts']));
  assert.deepEqual(unrelated.outcomes, { carry: 1 });
  const downgraded = replayKeepTheRun(carryThenLater(['convex/schema.ts']));
  assert.deepEqual(downgraded.outcomes, { 'carry-downgraded': 1 });
  const row = result => result.rows.keep.find(r => r.id === 'x');
  // The downgraded keep pays the recorded scoped recheck: 70 job-min and 10 min on top of the carry.
  assert(Math.abs(row(downgraded).runnerMinutes - row(unrelated).runnerMinutes - 70) < 0.01);
  assert(Math.abs(row(downgraded).runWallMinutes - row(unrelated).runWallMinutes - 10) < 0.01);
  // Early in the run the scoped recheck does not pay: the kept run is retired at the later mover.
  assert.deepEqual(replayKeepTheRun(carryThenLater(['convex/schema.ts'], { laterAt: 300 })).outcomes, {
    'retired-later': 1,
  });
});

test('fa2c1383 replay: a check input of the standard check is a protected path (no scoped recheck)', () => {
  const xPaths = ['src/x.ts', 'scripts/test-x.mjs'];
  const { reasons } = replayKeepTheRun(
    synthetic({
      landings: [
        { id: 'm1', submittedAt: -800, committedAt: 700, paths: ['convex/schema.ts'] },
        { id: 'x', submittedAt: 0, committedAt: 1600, paths: xPaths },
      ],
      runs: [
        ['m1-1', 'm1', -100, 800, 'passed', 'full', 100],
        ['x-1', 'x', 0, 702, 'cancelled', 'full'],
        ['x-2', 'x', 710, 800, 'passed', 'full', 100],
      ],
    }),
  );
  assert.deepEqual(reasons, { 'cannot-scope': 1 });
});

test('fa2c1383 replay: main stays red after a failed audit, and a scoped recheck in that window is retired', () => {
  // m1 (order-sensitive, late in x's run) keeps x for a scoped recheck that runs 800-1400 s; an
  // unrelated mover whose audit failed lands at 1000 s, and main is red until the next green mover.
  const trace = red =>
    synthetic({
      landings: [
        { id: 'm1', submittedAt: -800, committedAt: 700, paths: ['convex/schema.ts'] },
        { id: 'r', submittedAt: -100, committedAt: 1000, paths: ['src/r.ts'], auditFailed: red },
        { id: 'g', submittedAt: -100, committedAt: 1300, paths: ['src/g.ts'] },
        { id: 'x', submittedAt: 0, committedAt: 2000, paths: ['src/x.ts'] },
      ],
      runs: [
        ['m1-1', 'm1', -100, 800, 'passed', 'full', 100],
        ['r-1', 'r', 100, 800, 'passed', 'full', 100],
        ['g-1', 'g', 400, 800, 'passed', 'full', 100],
        ['x-1', 'x', 0, 702, 'cancelled', 'full'],
        ['x-2', 'x', 710, 800, 'passed', 'full', 100],
      ],
    });
  const green = replayKeepTheRun(trace(false));
  const red = replayKeepTheRun(trace(true));
  assert.equal(red.calibration.redSpans, 1);
  const row = result => result.rows.keep.find(r => r.id === 'x');
  assert.equal(row(green).cancelledJobMinutes, 0);
  // Retired at 1000 s after 200 s of a 12-shard recheck, restarted after main is green again.
  assert(row(red).cancelledJobMinutes > 0, JSON.stringify(row(red)));
  assert(row(red).runWallMinutes > row(green).runWallMinutes);
});

// Landing x's first full run is cancelled at 702 s by m1, which changes src/x.ts (an overlap), and
// its replacement passes. `later` lands at 750 s, while a kept run would still be running.
const overlapThenLater = (xPaths, laterPaths = null) =>
  synthetic({
    landings: [
      { id: 'm1', submittedAt: -800, committedAt: 700, paths: ['src/x.ts'] },
      ...(laterPaths ? [{ id: 'later', submittedAt: -100, committedAt: 750, paths: laterPaths }] : []),
      { id: 'x', submittedAt: 0, committedAt: 1600, paths: xPaths },
    ],
    runs: [
      ['m1-1', 'm1', -100, 800, 'passed', 'full', 100],
      ...(laterPaths ? [['later-1', 'later', -50, 800, 'passed', 'full', 100]] : []),
      ['x-1', 'x', 0, 702, 'cancelled', 'full'],
      ['x-2', 'x', 710, 800, 'passed', 'full', 100],
    ],
  });

test('fa2c1383 Lane B replay: an overlapping root-config or protected-path run still cancels through the rule', () => {
  // Review 0c7f9440 finding 3: with no projection branch, a clean probe lifts only the overlap, and
  // the rule's scope checks still refuse what today's recheck cannot scope.
  for (const xPaths of [
    ['src/x.ts', 'tsconfig.json'], // scoped-root-config: the recheck would run in full
    ['src/x.ts', 'scripts/test-x.mjs'], // a check input of the standard check
    ['src/x.ts', '.github/workflows/x.yml'], // the policy's protected paths
  ]) {
    const laneB = replayKeepTheRun(overlapThenLater(xPaths), { laneB: true });
    assert.deepEqual(laneB.reasons, { 'cannot-scope': 1 }, JSON.stringify(xPaths));
    assert.deepEqual(laneB.outcomes, {}, JSON.stringify(xPaths));
    assert.deepEqual(laneB.probes, { first: 0, firstRetiredLater: 0, again: 0, stale: 0 });
    assert.deepEqual(replayKeepTheRun(overlapThenLater(xPaths)).reasons, { 'code-overlap': 1 });
  }
  // The same overlap with scopable paths keeps for a scoped recheck, after one probe.
  const scopable = replayKeepTheRun(overlapThenLater(['src/x.ts', 'src/y.ts']), { laneB: true });
  assert.deepEqual(scopable.reasons, { 'scoped-recheck': 1 });
  assert.deepEqual(scopable.outcomes, { 'scoped-recheck': 1 });
  assert.equal(scopable.probes.first, 1);
});

test('fa2c1383 Lane B replay: a later mover re-probes a run that shares its path, and makes a probe stale otherwise', () => {
  const xPaths = ['src/x.ts', 'src/y.ts'];
  // A later mover on the same path probes again (the probe is sticky until clean on current main).
  assert.deepEqual(replayKeepTheRun(overlapThenLater(xPaths, ['src/y.ts']), { laneB: true }).probes, {
    first: 1,
    firstRetiredLater: 0,
    again: 1,
    stale: 0,
  });
  // A disjoint later mover moves main past the probe: the finish composes again.
  assert.deepEqual(replayKeepTheRun(overlapThenLater(xPaths, ['src/z.ts']), { laneB: true }).probes, {
    first: 1,
    firstRetiredLater: 0,
    again: 0,
    stale: 1,
  });
});
