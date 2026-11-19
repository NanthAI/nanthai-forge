// SPDX-License-Identifier: Apache-2.0
// Stats periods (Item a61d3c91): a read covers 1 to 92 real days, agents fold into four fixed first-try buckets
// (boundaries 100%, 75%, 50%), and a range reply re-aggregates only its own days into the part asked for: the head
// (headline and days) or one fold (stops, agent buckets, months).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATS_RANGE_MAX_DAYS,
  firstTryBuckets,
  rangeDays,
  statsRangeReply,
  validRange,
} from '../dist/stats-period.js';
import { statsDay } from '../dist/stats-estimate.js';

test('stats period: a range is 1 to 92 real, ordered days', () => {
  assert.equal(rangeDays({ from: '2026-11-01', to: '2026-11-30' }), 30);
  assert.equal(rangeDays({ from: '2026-11-18', to: '2026-11-18' }), 1);
  assert.equal(rangeDays({ from: '2026-11-18', to: '2026-11-17' }), 0, 'reversed');
  assert.equal(rangeDays({ from: '2026-02-30', to: '2026-03-01' }), 0, 'not a real day');
  assert.equal(validRange({ from: '2026-01-01', to: '2026-04-02' }), true, `${STATS_RANGE_MAX_DAYS} days`);
  assert.equal(validRange({ from: '2026-01-01', to: '2026-04-03' }), false, 'one day too many');
});

test('stats period: first-try buckets have fixed edges and count agents and their landings', () => {
  const row = (who, landings, firstTryRate) => ({ who, landings, firstTryRate });
  const { buckets, notCounted } = firstTryBuckets([
    row('a', 4, 1),
    row('b', 8, 0.75),
    row('c', 2, 0.7499),
    row('d', 3, 0.5),
    row('e', 9, 0.49),
    row('f', 1, null),
  ]);
  assert.deepEqual(
    buckets.map(b => [b.label, b.agents, b.landings]),
    [
      ['100%', 1, 4],
      ['75–99%', 1, 8],
      ['50–74%', 2, 5],
      ['Under 50%', 1, 9],
    ],
  );
  assert.deepEqual(notCounted, { agents: 1, landings: 1 });
});

test('stats period: a range reply covers its own days, one part at a time', () => {
  const day = (iso, n) =>
    statsDay(
      iso,
      Array.from({ length: n }, (_, i) => {
        const at = Date.parse(`${iso}T08:00:00Z`) + i * 60_000;
        return {
          id: `${iso}-${i}`,
          who: i % 2 ? 'amber-fox' : 'still-heron',
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
  assert.equal(agents.agents, 2);
  assert.equal('who' in agents, false, 'no per-agent list in the reply');
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
  const none = statsRangeReply([], { from: '2026-12-01', to: '2026-12-31' });
  assert.equal(none.through, null);
  assert.equal(none.window.landings, 0);
  assert.deepEqual(none.perDay, []);
});
