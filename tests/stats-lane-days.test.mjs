// SPDX-License-Identifier: Apache-2.0
// Lanes on days with no landing (Item a9ad21c9): the day close used to count only the Lanes started on the closed day
// itself, so a Lane started on a Saturday and landed on Monday, or one that crossed midnight UTC, was never counted
// (a project's day closes only when it had a landing). The close now counts every Lane since the previous closed day,
// each under its own day; a one-time backfill files the same Lanes for days closed before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { closeDay } = await import(moduleUrl('../convex/projectStats.ts'));
const backfill = await import(moduleUrl('../convex/statsLanesBackfill.ts'));
const { statsDay } = await import(moduleUrl('../src/stats-estimate.ts'));
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
      normalizeId: (_table, id) => id,
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

async function close(tables, day) {
  const { db, queries } = fakeDb(tables);
  await handler(closeDay)({ db }, { projectId: PROJECT, day });
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
