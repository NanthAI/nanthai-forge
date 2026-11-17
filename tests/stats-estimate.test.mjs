// SPDX-License-Identifier: Apache-2.0
// Stats estimates contract (Issue a61d3c91, docs/run-evidence.md#stats): the per-project GitHub-flow comparison is
// replayed from the project's own recorded landings, never a benchmark ratio. Guards the CI range
// (lower: a pull-request and a merge-queue run per change; upper: plus one rerun per landing that
// reached main while it waited), the one-at-a-time queue replay of time to main, and that landings
// with unknown runner minutes are excluded and counted, never priced as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_COMPARE_MIN_LANDINGS,
  replayEstimate,
  replayQueue,
  rerunsWhileWaiting,
  statsDay,
  statsDaySchema,
  statsWindow,
} from '../dist/stats-estimate.js';

const min = 60_000;
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

test('overlapping landings: each landing that reached main while another waited is one upper-bound rerun', () => {
  const day = [landing('a', 0, 5), landing('b', 1, 6), landing('c', 2, 7)];
  assert.deepEqual(rerunsWhileWaiting(day), [0, 1, 2]);
  const estimate = replayEstimate(day);
  assert.equal(estimate.runs, 6);
  assert.equal(estimate.reruns, 3);
  assert.deepEqual(estimate.replayRunnerSeconds, { low: 6 * 240, high: 9 * 240 });
  // Check takes 300 s; the queue runs one change at a time over the same arrivals.
  assert.deepEqual(estimate.replayToMainSeconds, [300, 540, 780]);
  assert.equal(estimate.measuredRunnerSeconds, 3 * 240);
});

test('a project with no overlap has equal bounds and every replayed change waits only for its own check', () => {
  const day = [landing('a', 0, 5), landing('b', 60, 65), landing('c', 120, 125)];
  const estimate = replayEstimate(day);
  assert.equal(estimate.reruns, 0);
  assert.equal(estimate.replayRunnerSeconds.low, estimate.replayRunnerSeconds.high);
  assert.deepEqual(estimate.replayToMainSeconds, [300, 300, 300]);
});

test('unknown runner minutes are excluded from both CI figures and counted, never treated as zero', () => {
  const day = [landing('a', 0, 5), landing('b', 1, 6, { runnerSeconds: null }), landing('c', 2, 7)];
  const estimate = replayEstimate(day);
  assert.equal(estimate.priced, 2);
  assert.equal(estimate.unknownRunner, 1);
  assert.equal(estimate.runs, 4, 'only priced landings get replayed runs');
  assert.equal(estimate.reruns, 2, 'the unpriced landing contributes no reruns');
  assert.equal(estimate.measuredRunnerSeconds, 480);
  // Arrival times stay in the queue replay: time to main needs no runner minutes.
  assert.equal(estimate.replayToMainSeconds.length, 3);
});

test('missing check times and runner data leave the replay unknown instead of inventing a cost', () => {
  const bare = landing('a', 0, 5, {
    checkStartedAt: null,
    checkEndedAt: null,
    runnerSeconds: null,
    discardedRunnerSeconds: null,
    attempts: null,
  });
  const estimate = replayEstimate([bare]);
  assert.equal(estimate.fullCheck.basis, 'none');
  assert.equal(estimate.replayRunnerSeconds, null);
  assert.equal(estimate.replayToMainSeconds, null);
  const day = statsDay('2026-11-01', [bare]);
  assert.equal(day.runner.unknown, 1);
  assert.equal(day.firstTry.counted, 0);
  assert.deepEqual(day.stops, { queue: [], check: [], land: [] });
  assert.equal(statsWindow([day]).measured.ciMinutesPerLanding, null);
});

test('a window replays only from scoped checks when no full check ran, and says so', () => {
  const day = [landing('a', 0, 5, { ranInFull: false, runnerSeconds: 60 })];
  assert.equal(replayEstimate(day).fullCheck.basis, 'scoped');
});

test('the replayed queue carries across days, and Stats compares only from the minimum window', () => {
  assert.deepEqual(replayQueue([10 * min], 300, 12 * min).toMainSeconds, [420]);
  const first = Array.from({ length: 30 }, (_, i) => landing(`d1-${i}`, i * 2, i * 2 + 5));
  const second = Array.from({ length: 30 }, (_, i) =>
    landing(`d2-${i}`, 1440 + i * 2, 1440 + i * 2 + 5, { who: 'agent/b', attempts: i % 2 ? 2 : 1 }),
  );
  const one = statsDay('2026-11-01', first);
  assert.equal(statsWindow([one]).comparison, null, `under ${STATS_COMPARE_MIN_LANDINGS} landings`);
  const two = statsDay('2026-11-02', second, one.replay.freeAt);
  for (const day of [one, two]) statsDaySchema.parse(JSON.parse(JSON.stringify(day)));
  const window = statsWindow([one, two]);
  assert.equal(window.landings, 60);
  assert.equal(window.measured.firstTryRate, 45 / 60);
  assert.equal(window.measured.ciMinutes, (60 * 240) / 60);
  assert.ok(window.comparison.savedMinutes.atLeast > 0, 'two runs per change cost more than one');
  assert.ok(window.comparison.savedMinutes.upTo >= window.comparison.savedMinutes.atLeast);
  assert.ok(window.comparison.sooner > 0, 'arrivals every 2 min queue behind a 5 min check');
  assert.deepEqual(
    window.who.map(w => [w.who, w.landings, w.firstTryRate]),
    [
      ['agent/a', 30, 1],
      ['agent/b', 30, 0.5],
    ],
  );
});
