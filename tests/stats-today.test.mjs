// SPDX-License-Identifier: Apache-2.0
// Stats today so far (Item 580b1a1a): opening Stats schedules one provisional close of the open UTC day, at most once an
// hour and only after a landing since the last; the totals then count today, the day's real close replaces the row,
// no month rollup reads it, and a later close treats a day still provisional as not closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storageClock } from './storage-clock.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { readLimits } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const todayApi = await import(moduleUrl('../convex/projectStatsToday.ts'));
const { utcDay } = await import(moduleUrl('../convex/projectStatsClose.ts'));
const { statsDay } = await import(moduleUrl('../src/stats-estimate.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.beforeEach(t => storageClock(t));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const DAY = 86_400_000;
const MIN = 60_000;
const closes = (f, before) =>
  [...f.tables._scheduled_functions.values()]
    .filter(task => !before.has(task._id) && task.name === 'projectStats:closeDay')
    .map(task => task.args[0]);
const ids = f => new Set(f.tables._scheduled_functions.keys());
const dayRows = (f, day) => [...f.tables.projectStatsDays.values()].filter(r => r.day === day);
/** Run with the fixture's fixed clock moved to `ms`. */
async function at(t, ms, run) {
  const clock = t.mock.method(Date, 'now', () => ms);
  try {
    return await run();
  } finally {
    clock.mock.restore();
  }
}
async function landedDay(t) {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const receipts = [...f.tables.projectHostedAcceptances.values()];
  const day = utcDay(receipts[0]._creationTime);
  return { f, receipts, day, start: Date.parse(`${day}T00:00:00.000Z`) };
}
/** One more accepted landing at `ms`: a copy of a receipt the close reads like any other. */
function landAt(f, receipt, ms, n) {
  const id = `today-a-${n}`;
  f.tables.projectHostedAcceptances.set(id, {
    ...receipt,
    _id: id,
    _creationTime: ms,
    value: JSON.stringify({
      ...JSON.parse(receipt.value),
      id,
      at: new Date(ms).toISOString(),
      submissionId: `today-s-${n}`,
    }),
  });
}
const open = f => f.tx('statsToday', todayApi.refreshToday, { projectId: f.projectId });
const read = async (f, day) =>
  JSON.parse(await f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: day, to: day }));

test('today counts so far after a Stats open, changes after a later landing, and the real close replaces it', async t => {
  const { f, receipts, day, start } = await landedDay(t);
  const noon = start + 12 * 3_600_000;
  // Two opens within the hour schedule one close; the close counts today's landings so far.
  const first = ids(f);
  assert.equal(await at(t, noon, () => open(f)), true);
  assert.deepEqual(closes(f, first), [{ projectId: f.projectId, day, provisional: true }]);
  await at(t, noon, () => f.tx('statsClose', statsApi.closeDay, closes(f, first)[0]));
  const [soFar] = dayRows(f, day);
  assert.equal(JSON.parse(soFar.value).provisional, noon);
  assert.equal(soFar.runnerContributions, undefined, 'no late-correction lists on a provisional row');
  const second = ids(f);
  assert.equal(await at(t, noon + 59 * MIN, () => open(f)), false, 'a second open within 60 min');
  assert.deepEqual(closes(f, second), [], 'two opens within 60 min schedule one close');
  let page = await at(t, noon, () => read(f, day));
  assert.equal(page.window.landings, receipts.length);
  assert.equal(page.todayUpTo, noon);
  // A refresh scheduled twice before either ran: the second reads one row and writes nothing.
  const writes = f.counts.length;
  await at(t, noon + 5 * MIN, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day, provisional: true }),
  );
  assert.equal(f.counts.slice(writes).find(c => c.name === 'statsClose').writes, 0);

  // An hour on with no landing since: nothing to schedule. After a landing, the next open counts it.
  const quiet = ids(f);
  assert.equal(await at(t, noon + 61 * MIN, () => open(f)), false, 'no landing since the last close');
  assert.deepEqual(closes(f, quiet), []);
  landAt(f, receipts[0], noon + 62 * MIN, 1);
  const later = ids(f);
  assert.equal(await at(t, noon + 63 * MIN, () => open(f)), true);
  await at(t, noon + 63 * MIN, () => f.tx('statsClose', statsApi.closeDay, closes(f, later)[0]));
  page = await at(t, noon + 63 * MIN, () => read(f, day));
  assert.equal(page.window.landings, receipts.length + 1, 'the totals change after a landing today');
  assert.equal(page.todayUpTo, noon + 63 * MIN);

  // After midnight UTC the scheduled refresh leaves the day alone; the real close replaces the row with a fresh one.
  const replaced = dayRows(f, day)[0]._id;
  await at(t, start + DAY + MIN, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day, provisional: true }),
  );
  assert.equal(dayRows(f, day)[0]._id, replaced, 'a refresh after midnight writes nothing');
  await at(t, start + DAY + MIN, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day }),
  );
  const rows = dayRows(f, day);
  assert.equal(rows.length, 1, 'one row for the day');
  assert.notEqual(rows[0]._id, replaced, 'a fresh row: its creation time is the real close’s');
  const closed = JSON.parse(rows[0].value);
  assert.equal(closed.provisional, undefined, 'the real close replaces the provisional row');
  assert.equal(closed.landings, receipts.length + 1);
  assert(rows[0].runnerContributions?.length, 'the closed row keeps its late-correction lists');
  page = await at(t, start + DAY + MIN, () => read(f, day));
  assert.equal(page.todayUpTo, null);
});

test('a later close finds a day still provisional, marks it not measured and closes it first', async t => {
  const { f, day, start } = await landedDay(t);
  await at(t, start + 12 * 3_600_000, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day, provisional: true }),
  );
  // Its real close never ran (it threw, say); the next landing day's close comes.
  const next = utcDay(start + 2 * DAY);
  const before = ids(f);
  await at(t, start + 3 * DAY, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: next }),
  );
  const mark = JSON.parse(dayRows(f, day)[0].value);
  assert.equal(mark.provisional, undefined);
  assert.equal(mark.failed?.tries, 1, 'not measured, try 1, as a gap day');
  assert.deepEqual(closes(f, before), [{ projectId: f.projectId, day, then: next }]);
  assert.equal(dayRows(f, next).length, 0, 'the later day waits for it');
});

test('a re-close of a day still provisional rebuilds it and leaves it provisional for its real close', async t => {
  const { f, day, start } = await landedDay(t);
  const noon = start + 12 * 3_600_000;
  await at(t, noon, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day, provisional: true }),
  );
  await at(t, start + 2 * DAY, () =>
    f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day, reclose: { through: day } }),
  );
  const [row] = dayRows(f, day);
  assert.equal(JSON.parse(row.value).provisional, noon, 'still provisional: the real close still runs');
  assert.equal(row.runnerContributions, undefined);
  await at(t, start + 2 * DAY, () => f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day }));
  assert.equal(JSON.parse(dayRows(f, day)[0].value).provisional, undefined, 'the real close finishes it');
});

test('a month rollup ignores a provisional row', async t => {
  const { f } = await landedDay(t);
  const put = (day, n, provisional) => {
    const landings = Array.from({ length: n }, (_, i) => ({
      id: `${day}-${i}`,
      who: 'amber-fox',
      submittedAt: Date.parse(`${day}T09:00:00.000Z`) + i * MIN,
      landedAt: Date.parse(`${day}T09:05:00.000Z`) + i * MIN,
      checkStartedAt: null,
      checkEndedAt: null,
      runnerSeconds: 100,
      discardedRunnerSeconds: 0,
      attempts: 1,
      ranInFull: true,
    }));
    f.tables.projectStatsDays.set(`sd-${day}`, {
      _id: `sd-${day}`,
      _creationTime: Date.parse(`${day}T12:00:00.000Z`),
      projectId: f.projectId,
      day,
      value: JSON.stringify({ ...statsDay(day, landings), ...(provisional ? { provisional: 1 } : {}) }),
    });
  };
  put('2026-10-01', 2, false);
  put('2026-10-02', 3, false);
  put('2026-10-31', 7, true);
  await f.tx('statsRoll', statsApi.rollMonth, { projectId: f.projectId, month: '2026-10' });
  const month = JSON.parse([...f.tables.projectStatsMonths.values()][0].value);
  assert.equal(month.totals.landings, 5);
  assert.deepEqual(
    [month.cover.first, month.cover.last, month.cover.closed],
    ['2026-10-01', '2026-10-02', 2],
  );
});

test('a Stats open needs a signed-in member and reads at most one day row and one receipt', async t => {
  const { f, start } = await landedDay(t);
  await assert.rejects(
    f.transaction('statsToday', todayApi.refreshToday, { projectId: f.projectId }, null),
    error => error.data?.code === 'AUTH_REQUIRED',
  );
  const before = f.counts.length;
  await at(t, start + 12 * 3_600_000, () => open(f));
  const call = f.counts.slice(before).find(c => c.name === 'statsToday');
  assert.equal(call.readDocumentsByTable.projectStatsDays ?? 0, 1, 'today’s row (none: one empty range)');
  assert.equal(call.readDocumentsByTable.projectHostedAcceptances, 1, 'one receipt');
  assert.equal(call.writes, 1, 'the scheduled close only');
});

// Calls and DB I/O per provisional close, at dogfood scale (200 landings a day, two check runs each) and doubled.
async function scaleDay(t, n) {
  const { f, receipts, day, start } = await landedDay(t);
  const receipt = receipts[0];
  const request = [...f.tables.projectHostedLandingRequests.values()].find(r => r.phase === 'landed');
  const lane = [...f.tables.projectHostedOverlapLanes.values()][0];
  const put = (table, id, row) => f.tables[table].set(id, { ...row, _id: id });
  for (let i = 0; i < n; i++) {
    const ms = start + MIN + i * 200_000;
    const submissionId = `sc-s-${i}`;
    put('projectHostedAcceptances', `sc-a-${i}`, {
      ...receipt,
      _creationTime: ms,
      value: JSON.stringify({ ...JSON.parse(receipt.value), id: `sc-a-${i}`, submissionId }),
    });
    put('projectHostedLandingRequests', `sc-r-${i}`, {
      ...request,
      _creationTime: ms - 10,
      submissionId,
      intentId: `sc-i-${i}`,
      requestBodyId: undefined,
      selectionBodyId: undefined,
      value: JSON.stringify({ ...JSON.parse(request.value), id: submissionId }),
    });
    put('projectHostedOverlapLanes', `sc-l-${i}`, {
      ...lane,
      _creationTime: ms - 60_000,
      laneId: `sc-lane-${i}`,
    });
    for (const k of [0, 1])
      put('projectFinishReadRows', `sc-run-${i}-${k}`, {
        _creationTime: ms + k,
        kind: 'projectMetricCheckRuns',
        projectId: f.projectId,
        sourceId: `sc-run-${i}-${k}`,
        sourceCreatedAt: ms + k,
        value: JSON.stringify({
          id: `sc-run-${i}-${k}`,
          at: new Date(ms + k).toISOString(),
          endedAt: new Date(ms + k + 300_000).toISOString(),
          status: k ? 'failed' : 'passed',
          runnerMinutes: 5,
          fullSuite: true,
          auditRunnerSeconds: null,
        }),
      });
  }
  const now = start + 23 * 3_600_000;
  const before = f.counts.length;
  await at(t, now, () => open(f));
  // Convex's own limits for one close, as the worst-day tests in tests/stats-close.test.mjs run it.
  readLimits.documents = 32_000;
  try {
    await at(t, now, () =>
      f
        .transaction(
          'statsClose',
          statsApi.closeDay,
          { projectId: f.projectId, day, provisional: true },
          'owner',
        )
        .catch(error => {
          if (!/statsClose: (bounded|metadata)/.test(error.message)) throw error;
        }),
    );
  } finally {
    readLimits.documents = 4096;
  }
  const [refresh, close] = ['statsToday', 'statsClose'].map(name =>
    f.counts.slice(before).find(c => c.name === name),
  );
  return { refresh, close, landings: JSON.parse(dayRows(f, day)[0].value).landings };
}

test('a provisional close at dogfood scale and doubled: two calls, DB I/O linear in the day', async t => {
  const one = await scaleDay(t, 200);
  const two = await scaleDay(t, 400);
  const io = m => m.readBytes + m.writeBytes;
  for (const [n, s] of [
    [200, one],
    [400, two],
  ])
    t.diagnostic(
      `${n} landings: refresh ${s.refresh.documents} docs ${io(s.refresh)} B; close ${s.close.documents} docs, ` +
        `${s.close.ranges} queries, ${s.close.readBytes} B read, ${s.close.writes} writes ${s.close.writeBytes} B; ` +
        `$${((io(s.close) * 0.2) / 1e9).toFixed(5)} a close, $${((24 * io(s.close) * 0.2) / 1e9).toFixed(4)} a day at 24`,
    );
  assert.equal(one.landings, 200 + 4);
  assert.equal(two.landings, 400 + 4);
  // The open reads a few rows whatever the day holds.
  assert(io(two.refresh) < 20_000 && io(two.refresh) <= io(one.refresh) * 1.1, 'the open stays flat');
  // Doubling the day at most doubles the close's I/O, and 24 a day at dogfood scale stays under one cent.
  assert(io(two.close) < 2.2 * io(one.close), `${io(two.close)} vs ${io(one.close)}`);
  assert((24 * io(one.close) * 0.2) / 1e9 < 0.01);
});
