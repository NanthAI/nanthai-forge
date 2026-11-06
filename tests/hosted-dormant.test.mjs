// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { digest } from '../dist/hash.js';
import { policyPreset } from '../dist/autonomy-policy.js';

const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const dormant = await import(moduleUrl('../convex/projectHostedDormant.ts'));
const live = await import(moduleUrl('../convex/projectHostedLiveLanes.ts'));
const nowOverlaps = await import(moduleUrl('../convex/projectNowOverlaps.ts'));

const PEER = 'user_PEERACCOUNT01';
const DAY = 24 * 3_600_000;
const shared = 'src/shared.ts';
const changeFor = (path, seed) => [
  { path, before: null, after: { blob: digest(path + seed), mode: 'file' } },
];

/** The caller's Lane plus peers, written through the real Lane record path. */
async function project() {
  const s = await saveFixture('original', 'a.txt');
  const mine = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId: s.projectId,
      snapshotId: 'seed',
      sourceRevision: 0,
      channel: 'main',
      head: mine.head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  s.insert('forgeAccounts', { owner: PEER, handle: 'peer-builder' });
  s.insert('projectContributors', { projectId: s.projectId, contributor: PEER });
  const write = (record, overlap, expectedVersion = null) =>
    s.transaction(
      'write',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion,
            record,
            overlap,
          }),
      },
      {},
    );
  const readLane = laneId =>
    s
      .transaction(
        'readLane',
        {
          _handler: async ctx =>
            (
              await records.readHostedRecord(ctx, {
                projectId: s.projectId,
                actor: 'owner',
                kind: 'lane',
                key: laneId,
              })
            ).value,
        },
        {},
      )
      .then(JSON.parse);
  /** A Lane with saved changes on `path` whose last record write was `idleMs` ago. */
  const lane = async (intent, { idleMs = 0, path = shared, extra = {} } = {}) => {
    const first = {
      ...mine,
      id: randomUUID(),
      intentId: randomUUID(),
      actor: PEER,
      version: 0,
      ...extra,
      at: new Date(Date.now() - idleMs).toISOString(),
    };
    await write(first, { baseSequence: 0, intent });
    const saved = { ...first, head: digest(first.id), version: 1, sourceVersion: 1 };
    await write(saved, { baseSequence: 0, intent, changes: changeFor(path, first.id) }, 0);
    return saved;
  };
  /** The Lane saves again `idleMs` ago (0: now). */
  const save = async (laneRecord, idleMs = 0) => {
    const current = await readLane(laneRecord.id);
    const next = {
      ...current,
      head: digest(current.head + 'again'),
      version: current.version + 1,
      sourceVersion: current.sourceVersion + 1,
      at: new Date(Date.now() - idleMs).toISOString(),
    };
    await write(
      next,
      { baseSequence: 0, intent: 'again', changes: changeFor(shared, next.head) },
      current.version,
    );
    return next;
  };
  // The caller's Lane changes the shared file too.
  const mineSaved = {
    ...mine,
    head: digest('mine'),
    version: mine.version + 1,
    sourceVersion: 1,
    at: new Date().toISOString(),
  };
  await write(
    mineSaved,
    { baseSequence: 0, intent: 'Dormant Lanes', changes: changeFor(shared, 'mine') },
    mine.version,
  );
  const read = (args = {}, actor = 'owner') =>
    s.transaction(
      'projectHostedOverlaps:read',
      overlaps.read,
      { projectId: s.projectId, laneId: mine.id, ...args },
      actor,
    );
  const setDormantDays = days =>
    s.patch('hostedProjects', s.projectId, {
      autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { dormantAfterDays: days } },
    });
  const overlapRow = laneId =>
    [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
  return { s, mine: mineSaved, lane, save, read, write, readLane, setDormantDays, overlapRow };
}
const noticeLanes = reply =>
  new Set(JSON.parse(reply).unacknowledgedOverlaps.items.flatMap(item => item.lanes));

test('a dormant Lane leaves overlap notices, and any save revives it (policy default 2 days)', async () => {
  const { read, lane, save, setDormantDays } = await project();
  const fresh = await lane('Fresh peer', { idleMs: 60_000 });
  const stale = await lane('Idle for three days, work long on main', { idleMs: 3 * DAY });
  const nearly = await lane('Idle for a day and a half', { idleMs: 1.5 * DAY });
  let lanes = noticeLanes(await read());
  assert(lanes.has(fresh.id) && lanes.has(nearly.id), 'live peers still notify');
  assert(!lanes.has(stale.id), 'the dormant peer is left out');
  const reply = JSON.parse(await read());
  assert.equal(
    reply.unacknowledgedOverlaps.coverage,
    'hosted',
    'dormant Lanes do not make coverage incomplete',
  );
  // A save revives it.
  await save(stale);
  assert(noticeLanes(await read()).has(stale.id), 'a save revives a dormant Lane');
  // A project can turn dormancy off, or tighten it.
  const old = await lane('Idle for ten days', { idleMs: 10 * DAY });
  assert(!noticeLanes(await read()).has(old.id));
  setDormantDays(0);
  assert(noticeLanes(await read()).has(old.id), 'dormantAfterDays 0 keeps every open Lane');
  setDormantDays(1);
  lanes = noticeLanes(await read());
  assert(!lanes.has(nearly.id) && lanes.has(fresh.id), 'a one-day policy drops the day-and-a-half Lane');
});

test('presence and the start sibling list skip dormant Lanes too', async () => {
  const { read, lane, mine } = await project();
  const sameIssue = intentId => ({ intentId });
  const live = await lane('Dormant Lanes follow-up', { extra: sameIssue(mine.intentId) });
  const stale = await lane('Dormant Lanes follow-up again', {
    idleMs: 4 * DAY,
    extra: sameIssue(mine.intentId),
  });
  const reply = JSON.parse(await read({ presence: {} }));
  const ids = reply.presence.lanes.map(entry => entry.laneId);
  assert(ids.includes(live.id));
  assert(!ids.includes(stale.id), 'dormant Lane is not shown as a peer');
});

test('rows from before lastActivityAt existed are judged by their presence time until they next write', async () => {
  const { read, lane, overlapRow, s } = await project();
  const freshLegacy = await lane('Legacy but active', { idleMs: 60_000 });
  const staleLegacy = await lane('Legacy and long idle', { idleMs: 5 * DAY });
  for (const peer of [freshLegacy, staleLegacy]) {
    const row = overlapRow(peer.id);
    assert(row.lastActivityAt > 0, 'new rows carry the field');
    s.patch('projectHostedOverlapLanes', row._id, { lastActivityAt: undefined });
    assert.equal(overlapRow(peer.id).lastActivityAt, undefined);
  }
  const unknown = await lane('Legacy with no activity evidence at all', { idleMs: 9 * DAY });
  s.patch('projectHostedOverlapLanes', overlapRow(unknown.id)._id, {
    lastActivityAt: undefined,
    presenceRow: undefined,
  });
  const lanes = noticeLanes(await read());
  assert(lanes.has(freshLegacy.id), 'an active legacy row still notifies');
  assert(!lanes.has(staleLegacy.id), 'an idle legacy row is left out without a backfill');
  assert(lanes.has(unknown.id), 'unknown activity counts as live: missing evidence never hides a Lane');
});

test('an Intent’s closed Lane and a parked Lane with saved work: only live work notifies', async () => {
  const { read, lane, readLane, write, overlapRow } = await project();
  const parked = await lane('Parked three days, never lands', { idleMs: 3 * DAY });
  const landedLane = await lane('Landed through another receipt', { idleMs: 3 * DAY });
  // The 0cfe3792 shape: saved, landed elsewhere, never saved again. Its overlap row is stamped landed.
  const row = overlapRow(landedLane.id);
  assert.equal(row.open, true);
  const lanes = noticeLanes(await read());
  assert(!lanes.has(parked.id) && !lanes.has(landedLane.id));
  // Closing a Lane still removes it (existing behaviour) and is unaffected by dormancy.
  const current = await readLane(parked.id);
  await write(
    { ...current, version: current.version + 1, state: 'abandoned', at: new Date().toISOString() },
    undefined,
    current.version,
  );
  assert.equal(overlapRow(parked.id).open, false);
});

test('notices per save before and after, on a dogfood-shaped project (60 open Lanes, 52 idle)', async () => {
  const { read, lane, s, setDormantDays } = await project();
  // Measured 2026-11-05 on the dogfood project: 60 active Lanes, 52 idle for hours or days, many with
  // work long on main. Eight are live. Every one changed the file the caller changed.
  for (let i = 0; i < 8; i++) await lane(`Live peer ${i}`, { idleMs: i * 60_000 });
  for (let i = 0; i < 52; i++) await lane(`Idle peer ${i}`, { idleMs: (3 + (i % 5)) * DAY + i * 3_600_000 });
  assert.equal([...s.tables.projectHostedOverlapLanes.values()].filter(row => row.open).length, 61);
  setDormantDays(0);
  const before = JSON.parse(await read());
  const beforeCount = s.counts.at(-1);
  setDormantDays(2);
  const after = JSON.parse(await read());
  const afterCount = s.counts.at(-1);
  console.log(
    `dormant fixture: notices per save before ${before.unacknowledgedOverlaps.count} -> after ${after.unacknowledgedOverlaps.count}; ` +
      `overlap rows read ${beforeCount.readDocumentsByTable.projectHostedOverlapLanes} -> ${afterCount.readDocumentsByTable.projectHostedOverlapLanes}; ` +
      `overlap-table bytes ${beforeCount.readBytesByTable.projectHostedOverlapLanes} -> ${afterCount.readBytesByTable.projectHostedOverlapLanes}; total bytes ${beforeCount.readBytes} -> ${afterCount.readBytes}; ranges ${beforeCount.ranges} -> ${afterCount.ranges}`,
  );
  assert(before.unacknowledgedOverlaps.count >= 50, 'the idle Lanes made the noise');
  assert.equal(after.unacknowledgedOverlaps.count, 8, 'only the live peers notify');
  assert(
    afterCount.readDocumentsByTable.projectHostedOverlapLanes <= 12,
    'only live rows (and the caller’s own) are read',
  );
  assert(
    afterCount.readBytesByTable.projectHostedOverlapLanes <
      beforeCount.readBytesByTable.projectHostedOverlapLanes / 3,
    'dormant overlap rows are never read',
  );
  assert(afterCount.readBytes < beforeCount.readBytes, 'the whole read is smaller');
});

test('board signals skip dormant Lanes', async () => {
  const { lane, s } = await project();
  const fresh = await lane('Fresh peer');
  const stale = await lane('Stale peer', { idleMs: 6 * DAY });
  const result = await s.transaction(
    'nowOverlaps',
    { _handler: async ctx => nowOverlaps.readNowOverlaps(ctx, s.projectId, await ctx.db.get(s.projectId)) },
    {},
  );
  const text = JSON.stringify(result);
  assert(text.includes(fresh.id));
  assert(!text.includes(stale.id));
});

test('abandon-dormant: abandons landed and empty Lanes only, never saved-work or pinned Lanes; owner only', async () => {
  const { s, lane, readLane, overlapRow, mine } = await project();
  const landed = await lane('Landed, idle', { idleMs: 3 * DAY });
  const saved = await lane('Unlanded work, idle', { idleMs: 3 * DAY });
  const pinned = await lane('Pinned, idle', { idleMs: 3 * DAY, extra: { pinned: true } });
  const empty = await lane('Never saved, idle', { idleMs: 3 * DAY });
  const fresh = await lane('Active', { idleMs: 1000 });
  const row = overlapRow(landed.id);
  s.patch('projectHostedOverlapLanes', row._id, {
    landed: {
      receiptId: randomUUID(),
      commit: 'c'.repeat(64),
      laneHead: landed.head,
      at: new Date().toISOString(),
    },
  });
  // The empty Lane keeps its base head as its head.
  const emptyHead = await readLane(empty.id);
  await s.transaction(
    'rewind',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: emptyHead.version,
          record: {
            ...emptyHead,
            head: emptyHead.base.head,
            version: emptyHead.version + 1,
            at: emptyHead.at,
          },
        }),
    },
    {},
  );
  const list = async view =>
    JSON.parse(
      await s.transaction('lanes', live.list, { projectId: s.projectId, cursor: null, limit: 100, view }),
    ).page;
  const dormantRows = await list('dormant');
  const byId = new Map(dormantRows.map(entry => [entry.laneId, entry]));
  assert.equal(byId.get(landed.id).abandonable, 'landed');
  assert.equal(byId.get(empty.id).abandonable, 'empty');
  assert.equal(byId.get(saved.id).abandonable, null);
  assert.equal(byId.get(pinned.id).pinned, true);
  assert(!byId.has(fresh.id) && !byId.has(mine.id));
  assert.equal(
    (await list('live')).some(entry => entry.dormant),
    false,
  );
  assert((await list('all')).some(entry => entry.dormant === true));
  const abandon = (args, actor = 'owner') =>
    s
      .transaction('abandon', dormant.abandon, { projectId: s.projectId, authorityEpoch: 1, ...args }, actor)
      .then(JSON.parse);
  await assert.rejects(abandon({ abandon: [landed.id] }, PEER), /./);
  const done = await abandon({
    abandon: [landed.id, empty.id, saved.id, pinned.id, fresh.id],
    stamp: [saved.id],
  });
  const result = Object.fromEntries(
    done.results.map(entry => [entry.laneId + (entry.result === 'stamped' ? ':stamp' : ''), entry.result]),
  );
  assert.equal(result[landed.id], 'abandoned');
  assert.equal(result[empty.id], 'abandoned');
  assert.equal(result[saved.id], 'has-saved-work');
  assert.equal(result[pinned.id], 'pinned');
  assert.equal(result[fresh.id], 'not-dormant');
  assert.equal((await readLane(landed.id)).state, 'abandoned');
  assert.equal((await readLane(landed.id)).head, landed.head, 'the saved head is kept');
  assert.equal((await readLane(saved.id)).state, 'active');
  assert.equal(overlapRow(landed.id).open, false);
  // A repeat finds nothing left to change.
  const again = await abandon({ abandon: [landed.id, empty.id] });
  assert.deepEqual(
    again.results.map(entry => entry.result),
    ['not-open', 'not-open'],
  );
  await assert.rejects(abandon({ abandon: Array.from({ length: 26 }, () => randomUUID()) }), /at most 25/);
});

test('stamp indexes a dormant legacy Lane so later reads skip its row', async () => {
  const { s, lane, overlapRow, read, setDormantDays } = await project();
  const stale = await lane('Legacy and idle', { idleMs: 5 * DAY });
  const row = overlapRow(stale.id);
  s.patch('projectHostedOverlapLanes', row._id, { lastActivityAt: undefined });
  setDormantDays(2);
  await read();
  const legacyRead = s.counts.at(-1).readBytesByTable.projectHostedOverlapLanes;
  const done = JSON.parse(
    await s.transaction('stamp', dormant.abandon, {
      projectId: s.projectId,
      authorityEpoch: 1,
      abandon: [],
      stamp: [stale.id],
    }),
  );
  assert.equal(done.results[0].result, 'stamped');
  assert(overlapRow(stale.id).lastActivityAt > 0);
  await read();
  const stamped = s.counts.at(-1).readBytesByTable.projectHostedOverlapLanes;
  assert(stamped < legacyRead, `${stamped} < ${legacyRead}`);
});
