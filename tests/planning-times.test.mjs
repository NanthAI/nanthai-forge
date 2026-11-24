// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { setWorkRecord } from './hosted-fixture.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { hostedRecordValue } from '../dist/hosted-records.js';
import { workStoreRecord } from '../dist/work-store-records.js';

const { storeVersion } = await import(moduleUrl('../convex/projectWorkStore.ts'));
const { withPlanningTimes, planningHistoryBudget, backfillPlanningTimes } = await import(
  moduleUrl('../convex/projectPlanningHistory.ts')
);
const backfill = await import(moduleUrl('../convex/projectPlanningTimesBackfill.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { command } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { recordPartition } = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));

async function fixture(t) {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  await s.ctx.db.patch(s.projectId, { workStore: 'records' });
  const { generationId } = project.work;
  const put = item =>
    storeVersion(
      s.ctx,
      s.projectId,
      hostedRecordValue(workStoreRecord('planningVersions', item)),
      undefined,
      false,
    );
  const head = id => [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === id);
  const detail = async (id, planningHistory = true) =>
    JSON.parse(
      (
        await index.detail._handler(s.ctx, {
          projectId: s.projectId,
          collection: 'planningItems',
          id,
          planningHistory,
        })
      ).value,
    );
  const walk = (item, limit = undefined) =>
    withPlanningTimes(
      s.ctx,
      project,
      generationId,
      JSON.stringify(item),
      planningHistoryBudget(undefined, limit),
    ).then(JSON.parse);
  const derive = item =>
    backfillPlanningTimes(
      s.ctx,
      project,
      generationId,
      JSON.stringify(item),
      planningHistoryBudget(undefined, Infinity),
    );
  const fill = cursor => backfill.page._handler(s.ctx, { projectId: s.projectId, cursor });
  return { ...s, put, head, detail, walk, derive, fill };
}

const start = Date.parse('2026-11-23T09:00:00Z');
function snapshot(id, version, status, extra) {
  return {
    id,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    version,
    previousVersion: version - 1,
    kind: 'issue',
    title: 'Synthetic Item',
    body: '',
    status,
    intentIds: [],
    at: new Date(start + version * 1000).toISOString(),
    provenance: 'user-declared-local',
    ...extra,
  };
}
const times = ({ lastStatusChangeAt, closedAt }) => ({ lastStatusChangeAt, closedAt });
const endpoints = (s, id) => {
  const selection = { projectId: s.projectId, collection: 'planningItems', planningHistory: true };
  return Promise.all([
    index.records._handler(s.ctx, { ...selection, paginationOpts: { cursor: null, numItems: 50 } }),
    index.detail._handler(s.ctx, { ...selection, id }),
  ]);
};

test('backfilling an old Item preserves full list and detail replies when its times are already known', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  await s.put(snapshot(id, 1, 'open'));
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  const closed = snapshot(id, 2, 'closed');
  await s.put(closed);
  await s.put(snapshot(id, 3, 'closed'));
  const before = await endpoints(s, id);
  assert.deepEqual(times(JSON.parse(before[0].page[0].value)), times(JSON.parse(before[1].value)));
  assert.equal(JSON.parse(before[1].value).closedAt, closed.at);
  assert.equal((await s.fill(null)).filled, 1);
  assert.deepEqual(await endpoints(s, id), before);
});

test('an unavailable journal snapshot cannot pin null and hide later retained evidence', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const closed = snapshot(id, 1, 'closed');
  await s.put(closed);
  const recordId = s.head(id).recordId;
  await s.ctx.db.patch(recordId, { journalSegment: 'synthetic-journal-pin' });
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  await s.put(snapshot(id, 2, 'closed'));
  assert.equal((await s.detail(id)).closedAt, null);
  assert.deepEqual((await s.fill(null)).blocked, [id]);
  assert.equal(s.head(id).planningTimes, undefined);
  const generation = s.tables.projectWorkGenerations.get(
    s.tables.hostedProjects.get(s.projectId).work.generationId,
  );
  for (const entry of indexedRecord('planningVersions', closed.operationId, id, 1, closed))
    setWorkRecord(s.tables, `recovered-${entry.key}`, {
      ...entry,
      _id: `recovered-${entry.key}`,
      _creationTime: 1,
      projectId: s.projectId,
      generationId: recordPartition(generation),
    });
  const before = await endpoints(s, id);
  assert.equal(JSON.parse(before[0].page[0].value).closedAt, closed.at);
  assert.equal(JSON.parse(before[1].value).closedAt, closed.at);
  assert.equal((await s.fill(null)).filled, 1);
  assert.deepEqual(await endpoints(s, id), before);
});

test('backfill verification visits every head despite byte splits, including heads on later pages', async t => {
  const s = await fixture(t);
  const ids = Array.from({ length: 13 }, randomUUID);
  for (const id of ids) {
    await s.put(snapshot(id, 1, 'open', { body: 'x'.repeat(180 * 1024) }));
    await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  }
  // Convex paginate can say SplitRequired with only a prefix of the requested page. The
  // bounded keyset walk must not interpret that prefix as a completed pass (or use it at all).
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const range = query(table);
    if (table === 'projectHostedRecordHeads')
      range.paginate = async () => ({
        page: [],
        isDone: true,
        pageStatus: 'SplitRequired',
        splitCursor: ids[0],
      });
    return range;
  };
  const pass = async () => {
    let cursor = null,
      scanned = 0,
      filled = 0;
    for (let page = 0; page < 13; page++) {
      const result = await s.fill(cursor);
      assert.deepEqual(result.blocked, []);
      scanned += result.scanned;
      filled += result.filled;
      cursor = result.nextCursor;
      if (cursor === null) return { scanned, filled };
    }
    assert.fail('keyset cursor did not finish');
  };
  assert.deepEqual(await pass(), { scanned: 13, filled: 13 });
  assert.deepEqual(await pass(), { scanned: 13, filled: 0 });
});

for (const first of ['backfill', 'status']) {
  test(`concurrent backfill and status mutation pin the final head when ${first} starts first`, async t => {
    const s = await fixture(t);
    await s.ctx.db.patch(s.projectId, {
      sourceAuthority: { mode: 'server', epoch: 1 },
      workStoreWriters: ['planning'],
    });
    const open = s.item();
    const projectId = s.projectId;
    const args = input => ({ projectId, operationId: input.operationId, command: JSON.stringify(input) });
    await command._handler(s.ctx, args(open));
    const headId = s.head(open.itemId)._id;
    await s.ctx.db.patch(headId, { planningTimes: undefined });
    const store = lanesFixture();
    for (const [table, rows] of Object.entries(store.tables))
      for (const [id, row] of s.tables[table] ?? []) rows.set(id, structuredClone(row));
    const close = { ...open, expectedVersion: 1, status: 'closed', operationId: randomUUID() };
    const reached = Promise.withResolvers(),
      release = Promise.withResolvers();
    let held = false;
    store.decorateContext((ctx, _, name) => {
      if (name !== first) return;
      const method = first === 'backfill' ? 'patch' : 'replace';
      const write = ctx.db[method];
      ctx.db[method] = async (id, value) => {
        await write(id, value);
        if (id === headId && !held) {
          held = true;
          reached.resolve();
          await release.promise;
        }
      };
    });
    const call = name =>
      name === 'backfill'
        ? store.call(name, backfill.page, { projectId, cursor: null })
        : store.call(name, command, args(close));
    const pending = call(first);
    try {
      await Promise.race([
        reached.promise,
        pending.then(() => assert.fail('mutation committed before the race')),
      ]);
      await call(first === 'backfill' ? 'status' : 'backfill');
    } finally {
      release.resolve();
      await pending;
    }
    const head = store.tables.projectHostedRecordHeads.get(headId);
    assert.equal(head.version, 2);
    assert.equal(head.status, 'closed');
    assert.deepEqual(head.planningTimes, {
      version: 2,
      lastStatusChangeAt: JSON.parse(head.value).at,
      closedAt: JSON.parse(head.value).at,
      closeKept: JSON.parse(head.value).at,
    });
    assert.ok(store.counts.some(row => row.name === first && row.retries > 0));
  });
}

test('Item heads match the uncapped walk through edits, shelves, restores, closes and invalid time evidence', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const transitions = [
    ['closed'],
    ['closed'],
    ['archived', 'closed'],
    ['deleted', 'closed'],
    ['closed'],
    ['open'],
    ['archived', 'open'],
    ['closed'],
    ['archived'],
    ['closed'],
    ['closed'],
    ['open', undefined, '2026-02-30T15:00:00Z'],
    ['open'],
  ];
  // The application preserves `was` while moving between shelves; restore is an ordinary status put.
  let rng = 12345;
  for (let i = 0; i < 100; i++) {
    rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
    const status = ['open', 'closed', 'in-progress', 'archived', 'deleted'][rng % 5];
    const [prior, was] = transitions.at(-1);
    transitions.push([
      status,
      ['archived', 'deleted'].includes(status)
        ? ['archived', 'deleted'].includes(prior)
          ? was
          : prior
        : undefined,
    ]);
  }
  for (const [i, [status, was, at]] of transitions.entries()) {
    const item = snapshot(id, i + 1, status, { ...(was ? { was } : {}), ...(at ? { at } : {}) });
    await s.put(item);
    assert.deepEqual(s.head(id).planningTimes, await s.derive(item), `version ${item.version} (${status})`);
    const legacy = times(await s.walk(item));
    const actual = times(await s.detail(id));
    for (const field of ['lastStatusChangeAt', 'closedAt'])
      if (legacy[field] !== null) assert.equal(actual[field], legacy[field], `${item.version}: ${field}`);
  }
  const raw = await s.detail(id, false);
  assert.equal('planningTimes' in raw || 'closeKept' in raw || 'closedAt' in raw, false);
});

test('backfill recovers a close past 32 edits, pins its version, and replays without rewriting it', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const original = snapshot(id, 1, 'closed');
  await s.put(original);
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  for (let version = 2; version <= 45; version++) await s.put(snapshot(id, version, 'closed'));
  assert.deepEqual(times(await s.detail(id)), { lastStatusChangeAt: null, closedAt: null });
  const filled = await s.fill(null);
  assert.equal(filled.filled, 1);
  assert.deepEqual(filled.blocked, []);
  assert.deepEqual(times(await s.detail(id)), { lastStatusChangeAt: original.at, closedAt: original.at });
  assert.equal((await s.fill(null)).filled, 0);
  await s.put(snapshot(id, 46, 'deleted', { was: 'closed' }));
  await s.put(snapshot(id, 47, 'closed'));
  assert.equal((await s.detail(id)).closedAt, original.at);
});

test('out-of-order copies invalidate a formerly incomplete head; stale pins and purge tombstones cannot answer times', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const first = snapshot(id, 1, 'closed');
  const second = snapshot(id, 2, 'closed');
  await s.put(second);
  assert.equal((await s.fill(null)).filled, 1);
  assert.equal((await s.detail(id)).closedAt, null);
  await s.put(first);
  assert.equal(s.head(id).planningTimes, undefined);
  await s.ctx.db.patch(s.head(id)._id, {
    planningTimes: { version: 1, lastStatusChangeAt: 'wrong', closedAt: 'wrong', closeKept: 'wrong' },
  });
  assert.equal((await s.detail(id)).closedAt, first.at);
  const operationId = randomUUID();
  await s.put(
    snapshot(id, 3, 'deleted', { operationId, purged: { operationId, deletedAt: second.at, by: 'owner' } }),
  );
  assert.deepEqual(times(await s.detail(id)), { lastStatusChangeAt: null, closedAt: null });
});

test('a head beyond the backfill page budget remains unpinned and is reported, not written with a guessed date', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  await s.put(snapshot(id, 1, 'closed', { body: 'x'.repeat(400 * 1024) }));
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  await s.put(snapshot(id, 2, 'closed'));
  const result = await s.fill(null);
  assert.equal(result.filled, 0);
  assert.deepEqual(result.blocked, [id]);
  assert.equal(s.head(id).planningTimes, undefined);
});
