// SPDX-License-Identifier: Apache-2.0
// Stats day close (Items 2cf30e0a, a61d3c91): a project's day closes once, when a landing on a later UTC
// day is recorded; the close reads each receipt and its landing row (with its body pages) once and writes one row; the read
// returns that day as measured figures only, with no clock argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const { scheduleStatsClose, utcDay } = await import(moduleUrl('../convex/projectStatsClose.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('only the first landing of a later UTC day schedules a close, for the previous day', async () => {
  const calls = [];
  const ctx = { scheduler: { runAfter: async (delay, ref, args) => calls.push({ delay, args }) } };
  const at = Date.parse('2026-11-04T23:59:00.000Z');
  await scheduleStatsClose(ctx, 'p', undefined, at);
  await scheduleStatsClose(ctx, 'p', at - 60_000, at);
  assert.equal(calls.length, 0, 'no previous landing, or the same day: nothing scheduled');
  await scheduleStatsClose(ctx, 'p', at, at + 120_000);
  assert.deepEqual(calls, [{ delay: 0, args: { projectId: 'p', day: '2026-11-04' } }]);
});

test('a closed day holds measured figures from receipts and landing rows, once', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const receipts = [...f.tables.projectHostedAcceptances.values()];
  assert.equal(receipts.length, 4);
  const day = utcDay(receipts[0]._creationTime);
  const before = f.counts.length;
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  const close = f.counts.slice(before).find(c => c.name === 'statsClose');
  // Per landing: its receipt, its request row and that row's two body pages; plus the day's own two lookups. A person's
  // day (Item 6a251b23) adds that day's Lanes once each and one row read and one write per active person.
  const lanes = [...f.tables.projectHostedOverlapLanes.values()].filter(
    lane => utcDay(lane._creationTime) === day,
  );
  const people = [...f.tables.personDays.values()];
  assert(people.length >= 1, 'the submitter has a day row');
  assert(
    close.documents <= 4 * receipts.length + 2 + lanes.length + people.length,
    `four reads per landing: ${close.documents}`,
  );
  assert(
    close.readBytes < 16_000 * receipts.length,
    `bytes per landing: ${close.readBytes / receipts.length}`,
  );
  assert.equal(close.writes, 1 + people.length);
  const counted = people.map(row => JSON.parse(row.value).p[f.projectId]);
  assert.equal(
    counted.reduce((n, entry) => n + entry.l, 0),
    4,
    'every landing counts once, for its submitter',
  );
  assert.equal(
    counted.reduce((n, entry) => n + entry.n, 0),
    lanes.length,
    'every Lane started that day counts once',
  );
  assert(
    people.every(row => row.value.length < 2_000),
    'a person-day row stays small',
  );
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  assert.equal(
    [...f.tables.personDays.values()].length,
    people.length,
    'a repeated close writes no new person rows',
  );
  const rows = [...f.tables.projectStatsDays.values()];
  assert.equal(rows.length, 1, 'a day closes once');
  const closed = JSON.parse(rows[0].value);
  assert.equal(closed.day, day);
  assert.equal(closed.landings, 4);
  assert.equal(closed.firstTry.counted + closed.runner.unknown >= 4, true);
  const read = JSON.parse(await f.tx('statsRead', statsApi.read, { projectId: f.projectId }));
  assert.equal(read.through, day);
  assert.deepEqual(read.perDay, [[day, 4]]);
  assert.equal(read.months[0].landings, 4);
  assert.equal(read.months[0].comparison, null, 'under 50 landings: measured only');
});
