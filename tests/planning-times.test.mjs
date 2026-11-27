// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workEventRows } from './work-event-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDocumentSize } from 'convex/values';
import { spendEvent } from '../scripts/convex-spend-model.mjs';
import { moduleUrl } from './convex-module.mjs';
import { setup, seedHistoricalIssueVersion } from './hosted-planning-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { hostedRecordValue } from '../dist/hosted-records.js';
import { workStoreRecord } from '../dist/work-store-records.js';

const { storeVersion } = await import(moduleUrl('../convex/projectWorkStore.ts'));
const { writeHostedRecord } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { withPlanningTimes, planningHistoryBudget } = await import(
  moduleUrl('../convex/projectPlanningHistory.ts')
);
const { provePlanningTimes } = await import(moduleUrl('../convex/projectPlanningTimesProof.ts'));
const backfill = await import(moduleUrl('../convex/projectPlanningTimesBackfill.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { command } = await import(moduleUrl('../convex/projectWorkCommand.ts'));

process.env.R2_SECRET_ACCESS_KEY = 'synthetic-planning-proof-key';

async function fixture(t) {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  const put = async (item, mode = 'historical') => {
    const encoded = hostedRecordValue(workStoreRecord('planningVersions', item));
    if (mode === 'records') return storeVersion(s.ctx, { _id: s.projectId }, encoded);
    return seedHistoricalIssueVersion(s, item);
  };
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
    withPlanningTimes(s.ctx, project, JSON.stringify(item), planningHistoryBudget(undefined, limit)).then(
      JSON.parse,
    );
  const derive = item => provePlanningTimes(s.ctx, head(item.id)).then(proof => proof.times);
  const fill = (cursor, headCursor) =>
    backfill.page._handler(s.ctx, { projectId: s.projectId, cursor, headCursor });
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
const workStale = error => (error.data?.code ?? error.code) === 'WORK_STALE';
const transactions = s => {
  const store = lanesFixture();
  for (const [table, rows] of Object.entries(store.tables))
    for (const [id, row] of s.tables[table] ?? []) rows.set(id, structuredClone(row));
  return store;
};
const endpoints = (s, id, includeHistory = true) => {
  const selection = {
    projectId: s.projectId,
    collection: 'planningItems',
    ...(includeHistory ? { planningHistory: true } : {}),
  };
  return Promise.all([
    index.records._handler(s.ctx, { ...selection, paginationOpts: { cursor: null, numItems: 50 } }),
    index.detail._handler(s.ctx, { ...selection, id }),
  ]);
};

test('ranked search reads the same timestamp pin as detail for the exact preview version', async t => {
  const s = await fixture(t);
  installPlanningSearch(s);
  const first = s.item({ title: 'Searchable pin evidence' });
  await s.send(first);
  await s.send(
    s.item({
      ...first,
      operationId: randomUUID(),
      expectedVersion: 1,
      status: 'closed',
    }),
  );
  const { search } = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
  const read = () =>
    search
      ._handler(s.ctx, {
        projectId: s.projectId,
        text: 'searchable',
        omittedTerms: 0,
        status: 'all',
        limit: 10,
        cursor: null,
        planningHistory: true,
      })
      .then(JSON.parse);
  const expected = times(await s.detail(first.itemId));
  const head = s.head(first.itemId);
  const query = s.ctx.db.query;
  const opened = [];
  s.ctx.db.query = table => {
    opened.push(table);
    return query(table);
  };
  const pinned = await read();
  assert.equal(pinned.items.length, 1);
  assert.equal(pinned.items[0].id, first.itemId);
  assert.deepEqual(times(pinned.items[0]), expected);
  assert.ok(!opened.includes('projectHostedRecords'), 'the exact pin needs no immutable history walk');
  await s.ctx.db.patch(head._id, { planningTimes: { ...head.planningTimes, version: 1 } });
  opened.length = 0;
  assert.deepEqual(times((await read()).items[0]), expected);
  assert.ok(opened.includes('projectHostedRecords'), 'a stale pin preserves the old exact read');
});

test('a canonical Issue write requires proved history and preserves the pin on an exact refresh', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const first = snapshot(id, 1, 'closed');
  const second = snapshot(id, 2, 'closed');
  await assert.rejects(s.put(second, 'records'), workStale);
  assert.equal(s.head(id), undefined);
  assert.equal([...s.tables.projectHostedRecords.values()].filter(row => row.key === id).length, 0);
  await s.put(first, 'records');
  await s.put(second, 'records');
  const pin = s.head(id).planningTimes;
  assert.deepEqual(pin, {
    version: 2,
    lastStatusChangeAt: first.at,
    closedAt: first.at,
    closeKept: first.at,
  });
  await s.ctx.db.patch(s.head(id)._id, { value: undefined });
  assert.equal(await s.put(second, 'records'), 'refreshed');
  assert.deepEqual(s.head(id).planningTimes, pin);

  const staged = randomUUID();
  await s.put(snapshot(staged, 2, 'open'));
  await assert.rejects(s.put(snapshot(staged, 1, 'open'), 'records'), workStale);
  assert.equal(s.head(staged).version, 2);
  assert.equal(s.head(staged).planningTimes, undefined);
});

test('the generic canonical writer cannot bypass Item pinning', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const project = s.tables.hostedProjects.get(s.projectId);
  await s.ctx.db.patch(s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  await assert.rejects(
    writeHostedRecord(s.ctx, {
      projectId: s.projectId,
      actor: project.owner,
      authorityEpoch: 1,
      expectedVersion: null,
      record: workStoreRecord('planningVersions', snapshot(id, 1, 'open')),
    }),
    { code: 'BAD_ARGUMENT' },
  );
  assert.equal(s.head(id), undefined);
});

test('list and detail emit only the missing or stale fallback label, with unchanged reads and replies', async t => {
  const s = await fixture(t);
  const ids = Array.from({ length: 2 }, randomUUID);
  const current = ids.map(id => snapshot(id, 2, 'closed'));
  for (const item of current) {
    await s.put(snapshot(item.id, 1, 'open'), 'records');
    await s.put(item, 'records');
  }
  const logs = [];
  t.mock.method(console, 'log', line => {
    if (typeof line === 'string') logs.push(line);
  });
  const fallback = () => logs.filter(line => line.includes('planning/history-fallback'));
  const warm = await endpoints(s, ids[0]);
  assert.equal(fallback().length, 0);
  for (const id of ids) await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  const meter = meterReads(s.ctx);
  const plain = await meter.cost(() => endpoints(s, ids[0], false));
  const project = s.tables.hostedProjects.get(s.projectId);
  const walk = await meter.cost(async () => {
    for (const item of [...current, current[0]])
      await withPlanningTimes(s.ctx, project, JSON.stringify(item), planningHistoryBudget());
  });
  const cold = await meter.cost(async () => {
    assert.deepEqual(await endpoints(s, ids[0]), warm);
  });
  assert.ok(walk.documents > 0, 'the fixture actually reads history');
  assert.deepEqual(cold, { documents: plain.documents + walk.documents, bytes: plain.bytes + walk.bytes });
  const only = reason => {
    const label = `planning/history-fallback-${reason}`;
    const line = `FORGE_IO_ATTRIBUTION ${JSON.stringify({ label })}`;
    assert.deepEqual(fallback(), [line, line], 'list and detail each emit exactly a static label');
    const entry = spendEvent(
      {
        kind: 'Completion',
        identifier: 'projectWorkIndex:records',
        timestamp: 1,
        requestId: 'synthetic-request',
        executionId: 'synthetic-execution',
        logLines: [line],
      },
      'synthetic-deployment',
    );
    assert.equal(entry.attribution, label);
  };
  only('missing');
  logs.length = 0;
  for (const id of ids)
    await s.ctx.db.patch(s.head(id)._id, {
      planningTimes: { version: 1, lastStatusChangeAt: null, closedAt: null, closeKept: null },
    });
  assert.deepEqual(await endpoints(s, ids[0]), warm);
  only('stale');
});

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

test('an incomplete canonical snapshot cannot pin null before the exact body is restored', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const closed = snapshot(id, 1, 'closed');
  await s.put(closed);
  const recordId = s.head(id).recordId;
  const { bodyId } = s.tables.projectHostedRecords.get(recordId);
  const { value } = s.tables.projectHostedRecordBodies.get(bodyId);
  await s.ctx.db.patch(bodyId, { value: '' });
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  await s.put(snapshot(id, 2, 'closed'));
  assert.deepEqual((await s.fill(null)).blocked, [id]);
  assert.equal(s.head(id).planningTimes, undefined);
  await s.ctx.db.patch(bodyId, { value });
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
  test(`an unpinned head rolls back the ${first === 'backfill' ? 'retained' : 'journal-backed'} planning write until backfill`, async t => {
    const s = await fixture(t);
    await s.ctx.db.patch(s.projectId, {
      sourceAuthority: { mode: 'server', epoch: 1 },
    });

    const open = s.item();
    const projectId = s.projectId;
    const args = input => ({ projectId, operationId: input.operationId, command: JSON.stringify(input) });
    await command._handler(s.ctx, args(open));
    const headId = s.head(open.itemId)._id;
    await s.ctx.db.patch(headId, { planningTimes: undefined });
    const store = transactions(s);
    const close = { ...open, expectedVersion: 1, status: 'closed', operationId: randomUUID() };
    const reached = Promise.withResolvers(),
      release = Promise.withResolvers();
    let held = false;
    store.decorateContext((ctx, _, name) => {
      if (name !== 'backfill') return;
      const write = ctx.db.patch;
      ctx.db.patch = async (id, value) => {
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
    const refused = async () => {
      const before = structuredClone(store.tables);
      await assert.rejects(call('status'), workStale);
      assert.deepEqual(store.tables, before, 'projection, event and head remain unchanged');
    };
    if (first === 'status') await refused();
    const pending = call('backfill');
    try {
      await Promise.race([
        reached.promise,
        pending.then(() => assert.fail('backfill committed before the race')),
      ]);
      if (first === 'backfill') await refused();
      assert.equal(store.tables.projectHostedRecordHeads.get(headId).version, 1);
    } finally {
      release.resolve();
      await pending;
    }
    await call('status'); // Same operation ID: the refused write retained no outcome or body.
    if (first === 'status')
      assert.ok(workEventRows(store.tables).some(row => row.operationId === close.operationId));
    const head = store.tables.projectHostedRecordHeads.get(headId);
    assert.equal(head.version, 2);
    assert.equal(head.status, 'closed');
    assert.deepEqual(head.planningTimes, {
      version: 2,
      lastStatusChangeAt: JSON.parse(head.value).at,
      closedAt: JSON.parse(head.value).at,
      closeKept: JSON.parse(head.value).at,
    });
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

test('out-of-order copies cannot pin a history gap; stale pins and purge tombstones cannot answer times', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  const first = snapshot(id, 1, 'closed');
  const second = snapshot(id, 2, 'closed');
  await s.put(second);
  assert.deepEqual((await s.fill(null)).blocked, [id]);
  assert.equal(s.head(id).planningTimes, undefined);
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

async function longRestoredHistory(t) {
  const s = await fixture(t);
  const id = randomUUID();
  const original = snapshot(id, 1, 'closed', { body: 'x'.repeat(100 * 1024) });
  await s.put(original);
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  for (let n = 2; n <= 10; n++) await s.put(snapshot(id, n, 'closed', { body: original.body }));
  await s.put(snapshot(id, 11, 'archived', { was: 'closed', body: original.body }));
  const restored = snapshot(id, 12, 'closed', { body: original.body });
  await s.put(restored);
  for (const row of s.tables.projectHostedRecords.values()) {
    if (row.key !== id) continue;
    const body = s.tables.projectHostedRecordBodies.get(row.bodyId);
    await s.ctx.db.patch(row._id, { inline: body.value });
  }
  return { ...s, id, original, restored };
}

test('backfill resumes a byte-limited restore history without guessing a date or skipping the Item', async t => {
  const s = await longRestoredHistory(t);
  const first = await s.fill(null);
  assert.deepEqual(first.blocked, []);
  assert.equal(first.nextCursor, null);
  assert.equal(first.filled, 0);
  assert.equal(s.head(s.id).planningTimes, undefined);
  assert.equal(typeof first.headCursor, 'string');
  const headRead = getDocumentSize(s.head(s.id));
  const largestHeader = Math.max(...Array.from(s.tables.projectHostedRecords.values(), getDocumentSize));
  // This first window loads an inline head and shelf, no extra snapshot document or anchor.
  assert.ok(first.readBytes >= headRead + 384 * 1024);
  assert.ok(first.readBytes < headRead + 384 * 1024 + largestHeader);
  const result = await backfill.run._handler(
    { runMutation: (_, args) => s.fill(args.cursor, args.headCursor) },
    {
      projectId: s.projectId,
      cursor: null,
      headCursor: first.headCursor,
      pages: 24,
      budgetBytes: 20_000_000,
    },
  );
  assert.equal(result.filled, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.nextCursor, null);
  assert.equal(result.headCursor, undefined);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(times(await s.detail(s.id)), {
    lastStatusChangeAt: s.restored.at,
    closedAt: s.original.at,
  });
  const replay = await s.fill(null, first.headCursor);
  assert.equal(replay.filled, 0);
  assert.equal(replay.headCursor, undefined);
  assert.equal(replay.nextCursor, null);
});

test('a checkpoint cannot skip an unproved open to closed transition', async t => {
  const s = await fixture(t);
  const id = randomUUID();
  await s.put(snapshot(id, 1, 'open'));
  await s.ctx.db.patch(s.head(id)._id, { planningTimes: undefined });
  await s.put(snapshot(id, 2, 'open'));
  const closed = snapshot(id, 3, 'closed');
  await s.put(closed);
  await s.put(snapshot(id, 4, 'closed'));
  const { recordId, version, status } = s.head(id);
  const forged = `${JSON.stringify({ key: id, recordId, version, status, visitedVersion: 2 })}.${'a'.repeat(64)}`;
  await assert.rejects(s.fill(null, forged), { code: 'BAD_ARGUMENT' });
  assert.equal(s.head(id).planningTimes, undefined);
  assert.equal((await s.fill(null)).filled, 1);
  assert.deepEqual(times(await s.detail(id)), { lastStatusChangeAt: closed.at, closedAt: closed.at });
});

test('a paused history proof restarts at the current version after a concurrent status move', async t => {
  const s = await longRestoredHistory(t);
  const { headCursor } = await s.fill(null);
  assert.ok(headCursor);
  const reopened = snapshot(s.id, 13, 'open');
  await s.put(reopened);
  assert.equal(s.head(s.id).planningTimes, undefined);
  const resumed = await s.fill(null, headCursor);
  assert.equal(resumed.filled, 1);
  assert.equal(resumed.headCursor, undefined);
  assert.deepEqual(times(await s.detail(s.id)), { lastStatusChangeAt: reopened.at, closedAt: null });
});
