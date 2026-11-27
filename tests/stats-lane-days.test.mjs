// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Lanes on days with no landing (Item a9ad21c9): the day close used to count only the Lanes started on the closed day
// itself, so a Lane started on a Saturday and landed on Monday, or one that crossed midnight UTC, was never counted
// (a project's day closes only when it had a landing). The close now counts every Lane since the previous closed day,
// each under its own day; a one-time backfill files the same Lanes for days closed before the fix.
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { closeDay } = await import(moduleUrl('../convex/projectStats.ts'));
const backfill = await import(moduleUrl('../convex/statsLanesBackfill.ts'));
const { statsDay, statsFailedDay, NO_CARRY } = await import(moduleUrl('../src/stats-estimate.ts'));
const { canonicalPayload } = await import(moduleUrl('../src/hosted-source-operation.ts'));

const at = (day, hour = 9, minute = 0) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
const handler = fn => fn._handler ?? fn.handler ?? fn;

/** ctx.db for these closes: eq / gt / gte / lt index ranges, order, take, first, unique, insert, patch. */
function fakeDb(tables) {
  let next = 0;
  const queries = [];
  const sortKey = row => row.day ?? row._creationTime;
  const query = table => {
    queries.push(table);
    let rows = [...(tables[table] ??= [])];
    let dir = 'asc';
    const api = {
      withIndex: (_name, range) => {
        const ops = [];
        const q = {};
        for (const op of ['eq', 'gt', 'gte', 'lt'])
          q[op] = (field, value) => (ops.push([op, field, value]), q);
        range?.(q);
        rows = rows.filter(row =>
          ops.every(([op, field, value]) => {
            const have = row[field];
            return op === 'eq'
              ? have === value
              : op === 'gt'
                ? have > value
                : op === 'gte'
                  ? have >= value
                  : have < value;
          }),
        );
        return api;
      },
      order: d => ((dir = d), api),
      take: n => {
        const sorted = [...rows].sort((a, b) =>
          sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0,
        );
        return Promise.resolve((dir === 'desc' ? sorted.reverse() : sorted).slice(0, n));
      },
      first: async () => (await api.take(1))[0] ?? null,
      unique: () => Promise.resolve(rows[0] ?? null),
    };
    return api;
  };
  return {
    queries,
    db: {
      query,
      // As Convex: an id normalizes only for the table that holds it (the finish-read writer asks per table).
      normalizeId: (table, id) => ((tables[table] ?? []).some(row => row._id === id) ? id : null),
      get: async id =>
        Object.values(tables)
          .flat()
          .find(row => row._id === id) ?? null,
      insert: async (table, value) => {
        (tables[table] ??= []).push({ _id: `n${next++}`, _creationTime: 0, ...value });
      },
      patch: async (id, value) =>
        Object.assign(
          Object.values(tables)
            .flat()
            .find(row => row._id === id),
          value,
        ),
    },
  };
}

const PROJECT = 'proj-1';
const lane = (iso, actor = 'acct-a', extra = {}) => ({
  _id: `lane-${iso}-${actor}-${Math.random()}`,
  _creationTime: Date.parse(iso),
  projectId: PROJECT,
  open: true,
  actor,
  ...extra,
});
const closedDay = day => ({
  _id: `closed-${day}`,
  _creationTime: at(day, 23),
  projectId: PROJECT,
  day,
  value: canonicalPayload(statsDay(day, [], 0)),
});
/** A day whose close did not finish (src/stats-estimate.ts#statsFailedDay), out of tries. */
const failedDay = (day, since) => ({
  _id: `failed-${day}`,
  _creationTime: at(day, 23),
  projectId: PROJECT,
  day,
  value: canonicalPayload(statsFailedDay(day, NO_CARRY, 3, since)),
});
const receipt = (iso, id = 'r1') => ({
  _id: `rec-${id}`,
  _creationTime: Date.parse(iso),
  projectId: PROJECT,
  value: JSON.stringify({
    id,
    submissionId: `s-${id}`,
    at: iso,
    actor: { id: 'acct-a', kind: 'agent' },
    agentRun: 'amber-fox',
  }),
});
const personRows = tables =>
  Object.fromEntries(
    (tables.personDays ?? [])
      .filter(row => row.person === 'acct-a')
      .map(row => [row.day, JSON.parse(row.value).p[PROJECT]]),
  );

async function close(tables, day, scheduled = []) {
  const { db, queries } = fakeDb(tables);
  // Convex's scheduler: recorded, never run.
  const scheduler = { runAfter: async (_delay, ref, args) => scheduled.push(args) };
  // The transaction's read meter, as Convex gives every function (the close stops its readers on it): queries made.
  const meta = {
    getTransactionMetrics: async () => ({
      databaseQueries: { used: queries.length, remaining: 4096 - queries.length },
      bytesRead: { used: 0, remaining: 16 * 1024 * 1024 },
      documentsRead: { used: 0, remaining: 32_000 },
      documentsWritten: { used: 0, remaining: 8192 },
      bytesWritten: { used: 0, remaining: 16 * 1024 * 1024 },
    }),
  };
  await handler(closeDay)({ db, meta, scheduler }, { projectId: PROJECT, day });
  return queries;
}

test('a Lane started on a weekend and landed on Monday is counted under its own day', async () => {
  const tables = {
    projectStatsDays: [closedDay('2026-11-13')],
    projectHostedAcceptances: [receipt('2026-11-16T09:00:00.000Z')],
    projectHostedOverlapLanes: [lane('2026-11-14T10:00:00.000Z'), lane('2026-11-16T08:00:00.000Z')],
  };
  await close(tables, '2026-11-16');
  const rows = personRows(tables);
  assert.deepEqual(
    Object.keys(rows).sort(),
    ['2026-11-14', '2026-11-16'],
    'Saturday gets its own row, Sunday none',
  );
  assert.equal(rows['2026-11-14'].n, 1, 'the Saturday Lane is counted');
  assert.equal(rows['2026-11-14'].l, 0);
  assert.equal(rows['2026-11-16'].n, 1, "Monday's own Lane is counted once");
  assert.equal(rows['2026-11-16'].l, 1);
  assert.deepEqual(
    rows['2026-11-14'].t,
    [at('2026-11-14', 10), at('2026-11-14', 10)],
    'first activity is the Saturday start',
  );
});

test('a Lane that crosses midnight UTC is filed under the day it started', async () => {
  const tables = {
    projectStatsDays: [closedDay('2026-11-10')],
    projectHostedAcceptances: [receipt('2026-11-12T00:10:00.000Z')],
    projectHostedOverlapLanes: [
      lane('2026-11-11T23:50:00.000Z', 'acct-a', { agent: 'amber-fox' }),
      lane('2026-11-12T00:05:00.000Z', 'acct-a', { open: false }),
    ],
  };
  await close(tables, '2026-11-12');
  const rows = personRows(tables);
  assert.equal(rows['2026-11-11'].n, 1, 'started 23:50 the day before, with no landing that day');
  assert.equal(rows['2026-11-11'].na, 1);
  assert.deepEqual(rows['2026-11-11'].r, { 'amber-fox': [1, 0, ''] });
  assert.equal(rows['2026-11-12'].n, 1, 'started 00:05 on the landing day, closed Lane');
  assert.equal(rows['2026-11-12'].l, 1);
});

test('the first close of a project counts its earlier Lanes, and a later close never recounts a closed day', async () => {
  const tables = {
    projectStatsDays: [],
    projectHostedAcceptances: [receipt('2026-11-09T09:00:00.000Z', 'a')],
    projectHostedOverlapLanes: [lane('2026-11-07T10:00:00.000Z'), lane('2026-11-09T07:00:00.000Z')],
  };
  await close(tables, '2026-11-09');
  assert.deepEqual(
    Object.entries(personRows(tables)).map(([day, entry]) => [day, entry.n]),
    [
      ['2026-11-07', 1],
      ['2026-11-09', 1],
    ],
  );
  const after = structuredClone(tables.personDays);
  // The project's next landing day: the window starts the day after 11-09, so 11-07 and 11-09 are not read again.
  tables.projectStatsDays.push(closedDay('2026-11-09'));
  tables.projectHostedAcceptances.push(receipt('2026-11-10T09:00:00.000Z', 'b'));
  tables.projectHostedOverlapLanes.push(lane('2026-11-10T07:00:00.000Z'));
  await close(tables, '2026-11-10');
  const rows = personRows(tables);
  assert.deepEqual(
    rows['2026-11-07'],
    JSON.parse(after.find(row => row.day === '2026-11-07').value).p[PROJECT],
  );
  assert.equal(rows['2026-11-09'].n, 1, 'a closed day keeps its count');
  assert.equal(rows['2026-11-10'].n, 1);
});

test('the close stays at two Lane range reads, however many days it spans, and never reads an unbounded range', async () => {
  const tables = {
    projectStatsDays: [closedDay('2025-01-01')],
    projectHostedAcceptances: [receipt('2026-11-16T09:00:00.000Z')],
    projectHostedOverlapLanes: [lane('2025-01-05T10:00:00.000Z'), lane('2026-11-01T10:00:00.000Z')],
  };
  const queries = await close(tables, '2026-11-16');
  assert.equal(
    queries.filter(table => table === 'projectHostedOverlapLanes').length,
    2,
    'open and closed, once each',
  );
  const rows = personRows(tables);
  assert.deepEqual(
    Object.keys(rows),
    ['2026-11-01', '2026-11-16'],
    'a gap past the 366-day lookback is not read',
  );
});

test('the backfill files Lanes of gap days only, once, and a rerun writes the same rows', async () => {
  const tables = {
    projectStatsDays: [closedDay('2026-11-06'), closedDay('2026-11-09'), closedDay('2026-11-10')],
    projectHostedOverlapLanes: [
      lane('2026-11-05T10:00:00.000Z'), // before the first closed day
      lane('2026-11-06T10:00:00.000Z'), // on a closed day: already counted by its close
      lane('2026-11-07T10:00:00.000Z', 'acct-a', { open: false }),
      lane('2026-11-08T22:00:00.000Z'),
      lane('2026-11-09T10:00:00.000Z'),
      lane('2026-11-12T10:00:00.000Z'), // after the last closed day: the next close counts it
    ],
    personDays: [
      {
        _id: 'pd-6',
        person: 'acct-a',
        day: '2026-11-06',
        value: JSON.stringify({ p: { [PROJECT]: { l: 0, la: 0, n: 1, na: 0, v: 0, t: [1, 1], r: {} } } }),
      },
    ],
  };
  const calls = [];
  const { db } = fakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async (_delay, _ref, args) => calls.push(args) } };
  const out = await handler(backfill.project)(ctx, { projectId: PROJECT });
  assert.equal(out.isDone, true);
  assert.equal(calls.length, 0, 'one run covers a small project');
  const first = structuredClone(personRows(tables));
  assert.deepEqual(Object.keys(first).sort(), ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(first['2026-11-06'].n, 1, 'a closed day is left as its close wrote it');
  for (const day of ['2026-11-05', '2026-11-07', '2026-11-08']) assert.equal(first[day].n, 1, day);
  await handler(backfill.project)(ctx, { projectId: PROJECT });
  assert.deepEqual(personRows(tables), first, 'a rerun replaces the same entries');
});

test('the backfill continues past a page of closed days from where it stopped', async () => {
  const days = Array.from({ length: backfill.BACKFILL_DAYS + 5 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1) + 2 * i * 864e5).toISOString().slice(0, 10),
  );
  const tables = {
    projectStatsDays: days.map(closedDay),
    projectHostedOverlapLanes: days.map(day =>
      lane(`${new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10)}T10:00:00.000Z`),
    ),
  };
  const calls = [];
  const { db } = fakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async (_delay, _ref, args) => calls.push(args) } };
  const first = await handler(backfill.project)(ctx, { projectId: PROJECT });
  assert.equal(first.isDone, false);
  assert.deepEqual(calls, [{ projectId: PROJECT, prev: days[backfill.BACKFILL_DAYS - 1] }]);
  const second = await handler(backfill.project)(ctx, { projectId: PROJECT, prev: calls[0].prev });
  assert.equal(second.isDone, true);
  assert.equal(calls.length, 1);
  assert.equal(
    Object.keys(personRows(tables)).length,
    days.length - 1,
    'every gap day of the closed days is filed once',
  );
});

test('the backfill keeps the planning counts a close wrote on gap days, whenever it runs (review 59bca412 MUST-3)', async () => {
  const change = (op, iso) => ({
    _id: `change-${op}`,
    _creationTime: Date.parse(iso),
    projectId: PROJECT,
    actor: 'acct-a',
    operationId: `work:${op}`,
    at: Date.parse(iso),
    command: {
      kind: 'change',
      source: 'work',
      action: op.startsWith('put') ? 'put-planning-item' : 'comment-planning-item',
    },
    kind: 'change',
  });
  const work = (op, command) => ({
    _id: `work-${op}`,
    projectId: PROJECT,
    operationId: op,
    command: JSON.stringify(command),
  });
  const tables = {
    projectStatsDays: [closedDay('2026-11-06')],
    projectHostedAcceptances: [receipt('2026-11-10T09:00:00.000Z')],
    projectHostedOverlapLanes: [lane('2026-11-07T10:00:00.000Z'), lane('2026-11-08T10:00:00.000Z')],
    // Gap-day planning work (no landing that day): an Item closed and a comment by a run on 11-08.
    projectCoordinationEvents: [
      change('put-1', '2026-11-08T11:00:00.000Z'),
      change('comment-1', '2026-11-08T12:00:00.000Z'),
    ],
    projectHostedRecordBodies: [
      work('put-1', { action: 'put-planning-item', itemId: 'item-1', status: 'closed', expectedVersion: 2 }),
      work('comment-1', {
        action: 'comment-planning-item',
        itemId: 'item-1',
        text: 'Done',
        agent: 'amber-fox',
      }),
    ],
  };
  await close(tables, '2026-11-10');
  const closed = personRows(tables);
  assert.deepEqual(
    [closed['2026-11-08'].n, closed['2026-11-08'].c, closed['2026-11-08'].m, closed['2026-11-08'].rc],
    [1, 1, 1, { 'amber-fox': 1 }],
    'the close counts the gap day’s Lane and planning work',
  );
  // As a capped close would have left them: a partial mark on a gap day and on the Stats day.
  const gap = tables.personDays.find(row => row.day === '2026-11-07' && row.person === 'acct-a');
  const marked = JSON.parse(gap.value);
  marked.p[PROJECT] = { ...marked.p[PROJECT], c: 2, pp: 1 };
  gap.value = canonicalPayload(marked);
  const statsRow = tables.projectStatsDays.find(row => row.day === '2026-11-10');
  statsRow.value = canonicalPayload({ ...JSON.parse(statsRow.value), planningPartial: true });
  const before = structuredClone(tables.personDays);
  const stats = statsRow.value;
  const { db } = fakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  for (let run = 0; run < 2; run++) {
    await handler(backfill.project)(ctx, { projectId: PROJECT });
    assert.deepEqual(tables.personDays, before, `run ${run + 1}: every entry as the close wrote it`);
    assert.equal(tables.projectStatsDays.find(row => row.day === '2026-11-10').value, stats);
  }
  // A backfill run before the close ever wrote planning (an older row with Lane counts only) still fills the Lanes.
  const lanesOnly = JSON.parse(tables.personDays.find(row => row.day === '2026-11-08').value);
  lanesOnly.p[PROJECT].n = 0;
  tables.personDays.find(row => row.day === '2026-11-08').value = canonicalPayload(lanesOnly);
  await handler(backfill.project)(ctx, { projectId: PROJECT });
  assert.deepEqual(
    [
      personRows(tables)['2026-11-08'].n,
      personRows(tables)['2026-11-08'].c,
      personRows(tables)['2026-11-08'].m,
    ],
    [1, 1, 1],
    'the Lane count is recounted; the planning counts stay',
  );
});

test('past the change-row cap, everyone who can plan here is marked, even with no counted work (review 59bca412)', async t => {
  storageClock(t);
  const { PERSON_WORK_CHANGES } = await import(moduleUrl('../convex/personWork.ts'));
  const { profileRead } = await import(moduleUrl('../src/person-days.ts'));
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  // Recent days, inside the 14 days of change rows Convex keeps, so only the cap makes this close partial.
  const today = Date.parse(`${iso(Date.now())}T00:00:00.000Z`);
  const day = iso(today - 86_400_000);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const change = (n, actor, action) => ({
    _id: `change-${n}`,
    _creationTime: start + 1000 + n,
    projectId: PROJECT,
    actor,
    operationId: `work:op-${n}`,
    at: start + 1000 + n,
    command: { kind: 'change', source: 'work', action },
    kind: 'change',
  });
  const tables = {
    hostedProjects: [{ _id: PROJECT, _creationTime: 1, owner: 'acct-b' }],
    projectContributors: [{ _id: 'c1', projectId: PROJECT, contributor: 'acct-c' }],
    projectStatsDays: [closedDay(iso(today - 3 * 86_400_000))],
    projectHostedAcceptances: [receipt(`${day}T09:00:00.000Z`)],
    projectHostedOverlapLanes: [],
    // The cap's worth of other changes, then acct-c's only planning work of the day: never read.
    projectCoordinationEvents: [
      ...Array.from({ length: PERSON_WORK_CHANGES }, (_, n) => change(n, 'acct-a', 'holder taken')),
      change(PERSON_WORK_CHANGES, 'acct-c', 'comment-planning-item'),
    ],
  };
  await close(tables, day);
  const entry = person =>
    JSON.parse(tables.personDays.find(row => row.person === person && row.day === day).value).p[PROJECT];
  assert.equal(JSON.parse(tables.projectStatsDays.find(row => row.day === day).value).planningPartial, true);
  for (const person of ['acct-a', 'acct-b', 'acct-c']) assert.equal(entry(person).pp, 1, person);
  assert.equal(entry('acct-c').m, undefined, 'acct-c’s comment was never read, so not counted');
  // acct-c's profile says its count is a floor, and shows no activity for a mark alone.
  const read = profileRead({
    handle: 'sample-c',
    self: true,
    scope: 'all',
    rows: [{ day, value: { p: { [PROJECT]: entry('acct-c') } } }],
    seen: new Map([[PROJECT, { visibility: 'public', shared: false, handle: 'sample-b', slug: 'open-one' }]]),
    projectsLeftOut: 0,
    agentsFrom: 0,
  });
  assert.deepEqual([read.closedPartial, read.days, read.projects, read.first], [true, [], [], null]);
});

async function closeAfterUnmeasuredDay() {
  const tables = {
    projectStatsDays: [closedDay('2026-11-05'), failedDay('2026-11-06', '2026-11-06')],
    projectHostedAcceptances: [receipt('2026-11-08T09:00:00.000Z')],
    projectHostedOverlapLanes: [lane('2026-11-06T10:00:00.000Z'), lane('2026-11-07T10:00:00.000Z')],
  };
  await close(tables, '2026-11-08');
  return personRows(tables);
}

// Done-when 22:05Z (Item a61d3c91): a day left not measured is not a closed day.
test('a close after a day left not measured counts that day’s Lanes, marked partial', async t => {
  // Keep the gap within planning retention so only the unmeasured day is partial.
  storageClock(t);
  const rows = await closeAfterUnmeasuredDay();
  assert.deepEqual(Object.keys(rows).sort(), ['2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(rows['2026-11-06'].n, 1, 'the not-measured day’s Lane is counted');
  assert.equal(rows['2026-11-06'].pp, 1, 'its landings were never read: a floor');
  assert.equal(rows['2026-11-07'].pp, undefined, 'a day with no row had no landings: exact');
});

test('the same close marks the gap partial after its planning rows age out (incident a61d3c91)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 22) });
  const rows = await closeAfterUnmeasuredDay();
  assert.equal(rows['2026-11-07'].n, 1, 'the gap day’s Lane is still counted');
  assert.equal(rows['2026-11-07'].pp, 1, 'archived planning rows make the count partial');
});

test('the backfill runs a gap on through a day left not measured, and files trailing ones', async () => {
  const tables = {
    projectStatsDays: [
      closedDay('2026-11-05'),
      failedDay('2026-11-06'),
      closedDay('2026-11-08'),
      failedDay('2026-11-10'),
    ],
    projectHostedOverlapLanes: [
      lane('2026-11-06T10:00:00.000Z'),
      lane('2026-11-07T10:00:00.000Z'),
      lane('2026-11-10T10:00:00.000Z'),
      lane('2026-11-11T10:00:00.000Z'), // after the last row: the next close's
    ],
  };
  const { db } = fakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const out = await handler(backfill.project)(ctx, { projectId: PROJECT });
  assert.equal(out.isDone, true);
  assert.deepEqual(Object.keys(personRows(tables)).sort(), ['2026-11-06', '2026-11-07', '2026-11-10']);
});

test('the backfill carries the last closed day across a page that ends on days left not measured', async () => {
  const { BACKFILL_DAYS } = backfill;
  const first = Date.parse('2026-09-01T00:00:00.000Z');
  const dayN = n => new Date(first + n * 86_400_000).toISOString().slice(0, 10);
  // A page of closed days ending on one left not measured, whose Lane the next page must still file.
  const tables = {
    projectStatsDays: [
      ...Array.from({ length: BACKFILL_DAYS - 1 }, (_, n) => closedDay(dayN(n))),
      failedDay(dayN(BACKFILL_DAYS - 1)),
      closedDay(dayN(BACKFILL_DAYS)),
    ],
    projectHostedOverlapLanes: [lane(`${dayN(BACKFILL_DAYS - 1)}T10:00:00.000Z`)],
  };
  const calls = [];
  const { db } = fakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async (_delay, _ref, args) => calls.push(args) } };
  assert.equal((await handler(backfill.project)(ctx, { projectId: PROJECT })).isDone, false);
  assert.deepEqual(calls, [
    { projectId: PROJECT, prev: dayN(BACKFILL_DAYS - 1), closed: dayN(BACKFILL_DAYS - 2) },
  ]);
  assert.equal((await handler(backfill.project)(ctx, calls[0])).isDone, true);
  assert.deepEqual(Object.keys(personRows(tables)), [dayN(BACKFILL_DAYS - 1)]);
});

test('the first close of a later month schedules one rollup, of the month before', async () => {
  const tables = {
    projectStatsDays: [closedDay('2026-10-30')],
    projectHostedAcceptances: [receipt('2026-11-02T09:00:00.000Z')],
  };
  const scheduled = [];
  await close(tables, '2026-11-02', scheduled);
  assert.deepEqual(scheduled, [{ projectId: PROJECT, month: '2026-10' }]);
  tables.projectHostedAcceptances.push(receipt('2026-11-03T09:00:00.000Z', 'r2'));
  const again = [];
  await close(tables, '2026-11-03', again);
  assert.deepEqual(again, [], 'a close in the same month schedules none');
});
