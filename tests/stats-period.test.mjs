// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats periods: the selected days supply each fold, including the setup and person breakdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_RANGE_MAX_DAYS, rangeDays, statsRangeReply, validRange } from '../dist/stats-period.js';
import { statsDay } from '../dist/stats-estimate.js';

test('stats period: a range is 1 to 92 real, ordered days', () => {
  assert.equal(rangeDays({ from: '2026-11-01', to: '2026-11-30' }), 30);
  assert.equal(rangeDays({ from: '2026-11-18', to: '2026-11-18' }), 1);
  assert.equal(rangeDays({ from: '2026-11-18', to: '2026-11-17' }), 0, 'reversed');
  assert.equal(rangeDays({ from: '2026-02-30', to: '2026-03-01' }), 0, 'not a real day');
  assert.equal(validRange({ from: '2026-01-01', to: '2026-04-02' }), true, `${STATS_RANGE_MAX_DAYS} days`);
  assert.equal(validRange({ from: '2026-01-01', to: '2026-04-03' }), false, 'one day too many');
});

test('stats period: a range reply covers its own days, one part at a time', () => {
  const day = (iso, n) =>
    statsDay(
      iso,
      Array.from({ length: n }, (_, i) => {
        const at = Date.parse(`${iso}T08:00:00Z`) + i * 60_000;
        return {
          id: `${iso}-${i}`,
          attribution: i % 2 ? 'agent:codex:gpt-6.2-sol' : 'person:example',
          submittedAt: at,
          landedAt: at + 300_000,
          checkStartedAt: at + 30_000,
          checkEndedAt: at + 280_000,
          runnerSeconds: 200,
          discardedRunnerSeconds: 0,
          attempts: 1,
          ranInFull: true,
        };
      }),
    );
  const oct = day('2026-10-31', 3),
    nov = day('2026-11-01', 5);
  const one = statsRangeReply([nov], { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(one.window.landings, 5);
  assert.deepEqual(one.perDay, [['2026-11-01', 5]]);
  assert.equal(
    'who' in one.window || 'stops' in one.window.measured,
    false,
    'the head carries no fold figures',
  );
  const agents = statsRangeReply([nov], { from: '2026-11-01', to: '2026-11-30' }, 'agents');
  assert.equal(agents.minimum, 5);
  assert.deepEqual(
    agents.agentRows.map(r => [r.identity, r.landings]),
    [[{ kind: 'other', reasons: { small: 5, legacy: 0, overflow: 0, unattributed: 0 } }, 5]],
  );
  const waited = statsRangeReply([nov], { from: '2026-11-01', to: '2026-11-30' }, 'waited');
  assert.deepEqual(waited.stops, { queue: 30, check: 250, land: 20 });
  const both = statsRangeReply([oct, nov], { from: '2026-10-01', to: '2026-11-30' }, 'months');
  assert.equal(both.landings, 8);
  assert.deepEqual(
    both.months.map(m => [m.month, m.landings]),
    [
      ['2026-10', 3],
      ['2026-11', 5],
    ],
  );
  // A month with a day read only in part says so (review b4dd69b4 finding 3).
  const partialOct = statsRangeReply(
    [{ ...oct, partial: true }, nov],
    { from: '2026-10-01', to: '2026-11-30' },
    'months',
  );
  assert.deepEqual(
    partialOct.months.map(m => [m.month, m.partial]),
    [
      ['2026-10', true],
      ['2026-11', false],
    ],
  );
  const head = statsRangeReply([{ ...oct, partial: true }, nov], { from: '2026-10-01', to: '2026-11-30' });
  assert.deepEqual(
    [head.window.partial, head.window.partialLandings, head.window.partialRuns],
    [true, true, false],
    'which part was read in part',
  );
  const none = statsRangeReply([], { from: '2026-12-01', to: '2026-12-31' });
  assert.equal(none.through, null);
  assert.equal(none.window.landings, 0);
  assert.deepEqual(none.perDay, []);
});
