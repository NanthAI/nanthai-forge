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
const superseded = await import(moduleUrl('../convex/projectHostedSuperseded.ts'));
const overlapLanded = await import(moduleUrl('../convex/projectHostedOverlapLanded.ts'));

const PEER = 'user_PEERACCOUNT01';
const DAY = 24 * 3_600_000;
const shared = 'src/shared.ts';
const changeFor = (path, seed, advisory = false) => [
  {
    path,
    // A base file with no range evidence reads as an advisory 'unavailable' pair; two additions block.
    before: advisory ? { blob: digest(path + 'base'), mode: 'file' } : null,
    after: { blob: digest(path + seed), mode: 'file' },
  },
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
  const lane = async (intent, { idleMs = 0, path = shared, extra = {}, advisory = false } = {}) => {
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
    await write(saved, { baseSequence: 0, intent, changes: changeFor(path, first.id, advisory) }, 0);
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
      // Path notices are gone (Issue 853fcde3): peers are read on the detail read.
      { projectId: s.projectId, laneId: mine.id, detail: true, ...args },
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
const noticeLanes = reply => new Set(JSON.parse(reply).peerEvidence.items.flatMap(item => item.lanes));

test('a dormant Lane leaves overlap notices, and any save revives it (policy default 2 days)', async () => {
  const { read, lane, save, setDormantDays } = await project();
  const fresh = await lane('Fresh peer', { idleMs: 60_000 });
  const stale = await lane('Idle for three days, work long on main', { idleMs: 3 * DAY });
  const nearly = await lane('Idle for a day and a half', { idleMs: 1.5 * DAY });
  let lanes = noticeLanes(await read());
  assert(lanes.has(fresh.id) && lanes.has(nearly.id), 'live peers still notify');
  assert(!lanes.has(stale.id), 'the dormant peer is left out');
  const reply = JSON.parse(await read());
  assert.equal(reply.peerEvidence.coverage, 'hosted', 'dormant Lanes do not make coverage incomplete');
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

test('a landing tick stamps legacy rows with unknown activity from their Lane record, so a dormant one stops notifying (ee9d5738)', async () => {
  const { read, lane, overlapRow, s } = await project();
  // Wave 5 shape: the Lane idled 64 h, its row predates lastActivityAt and holds no presence time.
  const legacy = (row, extra = {}) =>
    s.patch('projectHostedOverlapLanes', row._id, {
      lastActivityAt: undefined,
      presenceRow: undefined,
      ...extra,
    });
  const dormantPeer = await lane('Dormant, row from before the activity index', { idleMs: 64 * 3_600_000 });
  const livePeer = await lane('Live, row from before the activity index', { idleMs: 60_000 });
  legacy(overlapRow(dormantPeer.id));
  legacy(overlapRow(livePeer.id));
  let lanes = noticeLanes(await read({ detail: true }));
  assert(lanes.has(dormantPeer.id), 'before: unknown activity reads as live');
  const stamp = () =>
    s.transaction(
      'stamp legacy',
      { _handler: ctx => overlapLanded.stampLegacyOverlapActivity(ctx, s.projectId) },
      {},
    );
  assert.equal(await stamp(), 2);
  assert.equal(overlapRow(dormantPeer.id).lastActivityAt, Date.parse(dormantPeer.at), 'the Lane record time');
  assert.equal(overlapRow(livePeer.id).lastActivityAt, Date.parse(livePeer.at));
  lanes = noticeLanes(await read({ detail: true }));
  assert(!lanes.has(dormantPeer.id), 'after: the dormant Lane is left out');
  assert(lanes.has(livePeer.id), 'a live legacy Lane keeps notifying: real evidence, nothing hidden');
  assert.equal(overlapRow(dormantPeer.id).open, true, 'the Lane and its row stay open with their work');
  // Healed: one empty indexed range read, no Lane record read, no write.
  assert.equal(await stamp(), 0);
  const healed = s.counts.at(-1);
  assert.deepEqual(
    [healed.ranges, healed.readBytes, healed.writes],
    [1, 0, 0],
    JSON.stringify(healed.readRangesByTable),
  );
  // Bounded per tick; a row with no Lane record holds no open Lane and closes.
  const many = [];
  for (let i = 0; i < overlapLanded.LEGACY_STAMP_LIMIT + 2; i++)
    many.push(await lane(`Legacy ${i}`, { idleMs: 5 * 86_400_000 }));
  for (const peer of many) legacy(overlapRow(peer.id));
  const orphan = many.at(-1);
  for (const [id, head] of s.tables.projectHostedRecordHeads)
    if (head.kind === 'lane' && head.key === orphan.id) s.tables.projectHostedRecordHeads.delete(id);
  assert.equal(await stamp(), overlapLanded.LEGACY_STAMP_LIMIT);
  assert.equal(await stamp(), 2);
  assert.equal(await stamp(), 0);
  assert.equal(overlapRow(orphan.id).open, false);
  assert.equal(overlapRow(orphan.id).lastActivityAt, undefined, 'no time is invented for a missing record');
  for (const peer of many.slice(0, -1)) assert.equal(overlapRow(peer.id).lastActivityAt, Date.parse(peer.at));
  lanes = noticeLanes(await read({ detail: true }));
  assert(many.every(peer => !lanes.has(peer.id)));
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
    `dormant fixture: notices per save before ${before.peerEvidence.count} -> after ${after.peerEvidence.count}; ` +
      `overlap rows read ${beforeCount.readDocumentsByTable.projectHostedOverlapLanes} -> ${afterCount.readDocumentsByTable.projectHostedOverlapLanes}; ` +
      `overlap-table bytes ${beforeCount.readBytesByTable.projectHostedOverlapLanes} -> ${afterCount.readBytesByTable.projectHostedOverlapLanes}; total bytes ${beforeCount.readBytes} -> ${afterCount.readBytes}; ranges ${beforeCount.ranges} -> ${afterCount.ranges}`,
  );
  assert(before.peerEvidence.count >= 50, 'the idle Lanes made the noise');
  // Eight live pair notices, plus one hot-file note: nine live Lanes share the file (D2, 1eb42254).
  assert.equal(after.peerEvidence.count, 9, 'only the live peers notify');
  const hot = after.peerEvidence.items.filter(item => item.reason === 'hot-file');
  assert(hot.length <= 1 && hot.every(item => item.lanes.length <= 5), 'one hot-file note, live Lanes only');
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
    {
      _handler: async ctx =>
        nowOverlaps.readNowOverlapSignals(ctx, s.projectId, await ctx.db.get(s.projectId)),
    },
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

/** A dormant Lane's work reaches main without its own completion tick (the tick was lost) or through another Lane. */
test('abandon-dormant: a receipt that names the Lane head retires it although no completion stamped it', async () => {
  const { s, lane } = await project();
  const landedLate = await lane('Landed, tick lost', { idleMs: 3 * DAY });
  const other = await lane('Other Intent, same file', { idleMs: 3 * DAY });
  const candidateId = randomUUID();
  const receiptId = randomUUID();
  s.insert('projectHostedRecordHeads', {
    projectId: s.projectId,
    kind: 'candidate',
    key: candidateId,
    parent: landedLate.intentId,
    status: 'clean',
    version: 1,
    recordId: [...s.tables.projectHostedRecords.keys()][0],
  });
  s.insert('projectHostedLandingRequests', {
    projectId: s.projectId,
    candidateId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    actor: PEER,
    runnable: false,
    runId: null,
    phase: 'landed',
    sequence: 1,
    value: JSON.stringify({ acceptance: { receiptId, head: 'd'.repeat(64) } }),
  });
  s.insert('projectHostedAcceptancePlans', {
    projectId: s.projectId,
    receiptId,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    actor: PEER,
    inputsNext: null,
    dependenciesNext: null,
    inputPages: 1,
    dependencyPages: 0,
    lanes: 1,
    root: 'r'.repeat(8),
    appliedPage: 0,
    appliedEntry: 0,
  });
  const page = head => ({
    schema: 1,
    kind: 'forge-hosted-compose-page',
    entries: [
      {
        laneId: landedLate.id,
        head,
        version: landedLate.version,
        sourceVersion: landedLate.sourceVersion,
        lifecycleVersion: landedLate.lifecycleVersion,
        state: { object: { sha256: 'e'.repeat(64), size: 1 }, recipe: null },
      },
    ],
    next: null,
  });
  s.insert('projectHostedAcceptancePages', {
    projectId: s.projectId,
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'a'.repeat(64),
    root: 'r'.repeat(8),
    value: JSON.stringify(page(landedLate.head)),
  });
  const rows = JSON.parse(
    await s.transaction('lanes', live.list, {
      projectId: s.projectId,
      cursor: null,
      limit: 100,
      view: 'dormant',
    }),
  ).page;
  const byId = new Map(rows.map(entry => [entry.laneId, entry]));
  assert.equal(byId.get(landedLate.id).abandonable, 'landed', 'the receipt names this exact head');
  assert.equal(byId.get(other.id).abandonable, null, 'a Lane no receipt names stays');
  const done = JSON.parse(
    await s.transaction('abandon', dormant.abandon, {
      projectId: s.projectId,
      authorityEpoch: 1,
      abandon: [landedLate.id, other.id],
    }),
  );
  assert.deepEqual(Object.fromEntries(done.results.map(entry => [entry.laneId, entry.result])), {
    [landedLate.id]: 'abandoned',
    [other.id]: 'has-saved-work',
  });
});

test('abandon-dormant: the list carries the changed paths for the CLI main comparison; onMain rechecks the compared head', async () => {
  const { s, lane, readLane, save } = await project();
  const onMain = await lane('Work already on main', { idleMs: 3 * DAY });
  const moved = await lane('Saved again after the CLI looked', { idleMs: 3 * DAY });
  const list = async () =>
    JSON.parse(
      await s.transaction('lanes', live.list, {
        projectId: s.projectId,
        cursor: null,
        limit: 100,
        view: 'dormant',
      }),
    ).page;
  const byId = new Map((await list()).map(entry => [entry.laneId, entry]));
  assert.equal(byId.get(onMain.id).abandonable, null);
  assert.deepEqual(byId.get(onMain.id).changes, [
    { path: shared, after: { blob: digest(shared + onMain.id), mode: 'file' } },
  ]);
  assert.equal(byId.get(onMain.id).head, onMain.head);
  // The Lane is saved again (and still idle) between the list and the sweep: its compared head is gone.
  const resaved = await save(moved, 3 * DAY);
  assert.notEqual(resaved.head, moved.head);
  const done = JSON.parse(
    await s.transaction('abandon', dormant.abandon, {
      projectId: s.projectId,
      authorityEpoch: 1,
      abandon: [],
      onMain: [
        { laneId: onMain.id, head: onMain.head },
        { laneId: moved.id, head: moved.head },
      ],
    }),
  );
  assert.deepEqual(Object.fromEntries(done.results.map(entry => [entry.laneId, entry.result])), {
    [onMain.id]: 'abandoned',
    [moved.id]: 'has-saved-work',
  });
  assert.equal((await readLane(onMain.id)).state, 'abandoned');
  assert.equal((await readLane(onMain.id)).head, onMain.head, 'the saved head is kept');
  assert.equal((await readLane(moved.id)).state, 'active');
});

const HOUR = 3_600_000;
// The idle summary still shapes the default read's stack offer; the advice is read directly.
const idleAdvice = async (s, mine) => {
  const { hostedOverlapAdvice, IDLE_NOTICE_MS } = await import('../dist/hosted-overlap.js');
  const rows = [...s.tables.projectHostedOverlapLanes.values()];
  const own = rows.find(row => row.laneId === mine.id);
  const main = { head: own.baseHead, sourceRevision: 0 };
  const peers = rows.filter(row => row.laneId !== mine.id);
  return hostedOverlapAdvice(own, peers, null, main, true, 5, undefined, Date.now() - IDLE_NOTICE_MS)
    .overlaps;
};

test('advisory notices from Lanes idle over 6 hours collapse into one summary line; blocking ones stay', async () => {
  const { read, lane, s, mine } = await project();
  const fresh = await lane('Fresh advisory peer', { advisory: true, idleMs: 60_000 });
  const idle = [];
  for (let i = 0; i < 4; i++)
    idle.push(await lane(`Idle advisory peer ${i}`, { advisory: true, idleMs: 8 * HOUR + i * HOUR }));
  const idleBlocking = await lane('Idle but its additions block', { idleMs: 9 * HOUR });
  const summary = await idleAdvice(s, mine);
  const reasons = summary.items.map(item => item.reason);
  assert.equal(reasons.filter(reason => reason === 'idle-lanes').length, 1, 'one summary line');
  const line = summary.items.find(item => item.reason === 'idle-lanes');
  assert.equal(line.class, 'advisory');
  assert.match(line.text, /4 Lane\(s\) idle over 6 h/);
  const named = new Set(summary.items.filter(item => item !== line).flatMap(item => item.lanes));
  assert(named.has(fresh.id), 'a Lane idle under 6 h keeps its own notice');
  assert(named.has(idleBlocking.id), 'a blocking notice from an idle Lane is never hidden');
  for (const peer of idle) assert(!named.has(peer.id), 'idle advisory Lanes have no notice of their own');
  assert.equal(summary.blockingCount, 1);
  assert.equal(summary.advisoryCount, 2, 'the fresh Lane plus the one summary');
  assert.equal(summary.count, 3);
  // The detail read lists every Lane.
  const detail = JSON.parse(await read()).peerEvidence;
  assert(!detail.items.some(item => item.reason === 'idle-lanes'));
  for (const peer of idle) assert(detail.items.some(item => item.lanes.includes(peer.id)));
});

test('a landed Lane supersedes its quiet same-Intent siblings: no presence, no advisory notice, blocking stays', async () => {
  const { read, lane, save, s, overlapRow, readLane, write } = await project();

  const intentId = randomUUID();
  const sameIntent = { intentId };
  const quietAdvisory = await lane('Earlier attempt, advisory', {
    advisory: true,
    idleMs: 10 * HOUR,
    extra: sameIntent,
  });
  const quietBlocking = await lane('Earlier attempt, blocking additions', {
    idleMs: 10 * HOUR,
    extra: sameIntent,
  });
  const pinned = await lane('Pinned attempt', {
    advisory: true,
    idleMs: 10 * HOUR,
    extra: { intentId, pinned: true },
  });
  const recent = await lane('Sibling still being worked', {
    advisory: true,
    idleMs: HOUR,
    extra: sameIntent,
  });
  const other = await lane('Other Intent', { advisory: true, idleMs: 10 * HOUR });
  const landed = await lane('Successor that landed', { idleMs: 0, extra: sameIntent });
  // The successor started three hours ago: only siblings last written before that are earlier attempts.
  overlapRow(landed.id)._creationTime = Date.now() - 3 * HOUR;
  const run = () =>
    s.transaction(
      'supersede',
      {
        _handler: ctx =>
          superseded.supersedeQuietSiblings(ctx, {
            projectId: s.projectId,
            siblings: [...s.tables.projectHostedRecordHeads.values()].filter(
              head => head.kind === 'lane' && head.parent === intentId,
            ),
            laneId: landed.id,
            receiptId: 'receipt-1',
            at: new Date().toISOString(),
          }),
      },
      {},
    );
  assert.equal(await run(), 2, 'the two quiet, unpinned siblings');
  assert.equal(await run(), 0, 'idempotent');
  for (const peer of [quietAdvisory, quietBlocking]) {
    const row = overlapRow(peer.id);
    assert.equal(row.superseded.laneHead, row.head);
    assert.equal(row.superseded.by, landed.id);
    assert.equal(row.open, true, 'superseded is not abandoned: the Lane stays open with its work');
    assert.equal(row.presenceRow, undefined);
  }
  for (const peer of [pinned, recent, other, landed]) assert.equal(overlapRow(peer.id).superseded, undefined);
  // Presence skips them; the advisory notice is gone; the blocking notice stays.
  const reply = JSON.parse(await read({ presence: {} }));
  const present = reply.presence.lanes.map(entry => entry.laneId);
  assert(!present.includes(quietAdvisory.id) && !present.includes(quietBlocking.id));
  assert(present.includes(recent.id));
  const named = noticeLanes(JSON.stringify(reply));
  assert(!named.has(quietAdvisory.id), 'advisory notice from a superseded Lane is gone');
  assert(named.has(quietBlocking.id), 'a blocking notice from a superseded Lane with unlanded work stays');
  assert(named.has(recent.id));
  // A bare record write at the same head keeps it superseded and does not bring presence back.
  const current = await readLane(quietAdvisory.id);
  await write(
    { ...current, version: current.version + 1 },
    { baseSequence: 0, intent: 'again' },
    current.version,
  );
  assert(overlapRow(quietAdvisory.id).superseded, 'same head stays superseded');
  assert.equal(overlapRow(quietAdvisory.id).presenceRow, undefined);
  // A new save makes the Lane live again.
  await save(quietAdvisory);
  assert.equal(overlapRow(quietAdvisory.id).superseded, undefined);
  assert(overlapRow(quietAdvisory.id).presenceRow, 'presence is back after a save');
  assert(
    JSON.parse(await read({ presence: {} })).presence.lanes.some(entry => entry.laneId === quietAdvisory.id),
  );
  // Abandon then reopen at the same head also ends it.
  const again = await readLane(quietBlocking.id);
  await write({ ...again, version: again.version + 1, state: 'abandoned' }, undefined, again.version);
  await write(
    { ...again, version: again.version + 2, state: 'active' },
    { baseSequence: 0, intent: 'reopened' },
    again.version + 1,
  );
  assert.equal(overlapRow(quietBlocking.id).superseded, undefined, 'reopen ends supersession');
});
