// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './hosted-overlaps-fixture.mjs';
import { seedOverlapLane } from './hosted-overlap-list.mjs';
import { presenceMayShare } from '../dist/hosted-presence.js';
import { boundOverlapChanges } from '../dist/hosted-overlap.js';
import {
  delta,
  hex,
  read,
  readyLanding,
  rowOf,
  sweep,
  trackChange,
  unprunedOverlapQuery,
} from './hosted-overlap-buckets-fixture.mjs';

const unpruned = await unprunedOverlapQuery();
const readBoth = async (s, laneId, args) => {
  const result = await read(s, laneId, args);
  const baseline = await read(s, laneId, args, unpruned);
  assert.equal(result.wire, baseline.wire, 'wire reply matches the original query');
  return { ...result, baseline };
};

const BUCKETS = 'projectHostedOverlapChanges';
const PRESENCE = 'projectHostedPresence';
const HEADS = 'projectHostedRecordHeads';
const LANE_ROWS = 'projectHostedOverlapLanes';
const NOW = Date.parse('2026-10-02T00:00:00Z');

function seedLane(s, template, laneId, changes, status = 'active') {
  const { _id, _creationTime, ...row } = template;
  const head = [...s.tables[HEADS].values()].find(head => head.key === row.laneId);
  const { _id: headId, _creationTime: created, ...pointer } = head;
  s.insert(HEADS, { ...pointer, key: laneId, status });
  return seedOverlapLane(s.insert, {
    ...row,
    laneId,
    open: status !== 'completed',
    presenceRow: undefined,
    lastActivityAt: NOW - 60_000,
    ...changes,
  });
}

const readCost = ({ io }) => ({
  bytes: io.readBytes,
  documents: io.documents,
  ranges: io.ranges,
  bucketBytes: io.readBytesByTable[BUCKETS] ?? 0,
  bucketRanges: io.readRangesByTable[BUCKETS] ?? 0,
  presenceRows: io.readDocumentsByTable[PRESENCE] ?? 0,
  writeBytes: io.writeBytes,
});

test('one saved match keeps bucket reads flat as unrelated live peers and retained history grow', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { s, lane: mine, peer } = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  s.patch('hostedProjects', s.projectId, {
    autonomyPolicy: { ...project.autonomyPolicy, agentDefaults: { dormantAfterDays: 2 } },
  });
  const path = 'a.txt';
  const added = n => ({ ...delta(path, n), before: null });
  await trackChange(s, mine, [added(901)], 'Mine');
  await trackChange(s, peer, [...sweep(50), added(900)], 'One match');
  for (const who of [mine, peer]) s.patch(LANE_ROWS, rowOf(s, who.id)._id, { lastActivityAt: NOW });
  const unrelated = boundOverlapChanges(sweep(50, 'unrelated'));
  const { changes: wide } = boundOverlapChanges(sweep(540, 'wide-unrelated'));
  const addPeers = (from, to) => {
    for (let i = from; i < to; i++) {
      const id = seedLane(s, rowOf(s, peer.id), `unrelated-${i}`, i % 2 ? unrelated : { changes: wide });
      const row = s.tables[LANE_ROWS].get(id);
      assert(
        !presenceMayShare(row.pathSummary, new Set([path])),
        'the Bloom filter proves this peer disjoint',
      );
    }
  };
  readyLanding(s);
  const measure = async label => {
    const run = async api => {
      const heap = process.memoryUsage().heapUsed;
      const start = performance.now();
      const replies = [await read(s, mine.id, { path }, api), await read(s, mine.id, {}, api)];
      return {
        replies,
        cost: replies.map(readCost),
        wallMs: Math.round((performance.now() - start) * 10) / 10,
        heapDelta: process.memoryUsage().heapUsed - heap,
      };
    };
    const { replies: baseline, ...before } = await run(unpruned);
    const { replies: result, ...after } = await run();
    t.diagnostic(`${label}: path/default before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    for (const [i, old] of baseline.entries()) assert.equal(result[i].wire, old.wire);
    assert.equal(result[0].reply.peerEvidence.count, 1);
    return result;
  };

  addPeers(0, 10);
  const few = await measure('10 unrelated live');
  const { _id, _creationTime, ...old } = [...s.tables.projectHostedRecords.values()][0];
  for (let i = 0; i < 500; i++) {
    seedLane(s, rowOf(s, peer.id), `closed-${i}`, { changes: '[]' }, 'completed');
    s.insert('projectHostedRecords', { ...old, key: `old-${i}` });
  }
  const history = await measure('10 unrelated live + history');
  addPeers(10, 49);
  const many = await measure('49 unrelated live + history');
  for (const [i, baseline] of few.entries()) {
    assert.equal(history[i].wire, baseline.wire);
    assert.deepEqual(readCost(history[i]), readCost(baseline));
    assert.equal(readCost(many[i]).bucketBytes, readCost(baseline).bucketBytes);
    assert.equal(readCost(many[i]).bucketRanges, 2, 'only the caller and matching peer need a bucket');
    assert.equal(readCost(many[i]).writeBytes, 0);
  }
  assert.equal(few[0].reply.peerEvidence.coverage, 'hosted');
  assert.equal(many[0].reply.peerEvidence.coverage, 'hosted-incomplete', 'the 51st peer/head still counts');
});

test('a 540-file caller on main reads one own bucket for a path and keeps its full paths reply', async t => {
  const { s, lane: mine } = await setup(t);
  await trackChange(s, mine, [delta('a.txt', 901), ...sweep(539)], 'Wide caller');
  const path = { path: 'a.txt' };
  const hook = await readBoth(s, mine.id, path);
  const all = await read(s, mine.id, { ...path, paths: true });
  const { changedPaths, ...withoutPaths } = all.reply;
  t.diagnostic(
    `wide caller: hook before ${JSON.stringify(readCost(hook.baseline))} after ${JSON.stringify(readCost(hook))}; with paths ${JSON.stringify(readCost(all))}`,
  );
  assert.equal(changedPaths.paths.length, 540);
  assert.equal(hook.wire, JSON.stringify(withoutPaths));
  assert(readCost(hook.baseline).bucketBytes > 100_000);
  assert(readCost(hook).bucketBytes < 5_000);
});

test('one unmatched dormant head uses one presence row while a wider gap uses the dormant window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { s, lane: mine, peer } = await setup(t);
  const template = rowOf(s, peer.id);
  const cutoff = NOW - 2 * 86_400_000;
  const project = s.tables.hostedProjects.get(s.projectId);
  s.patch('hostedProjects', s.projectId, {
    autonomyPolicy: { ...project.autonomyPolicy, agentDefaults: { dormantAfterDays: 2 } },
  });
  const own = rowOf(s, mine.id);
  s.patch(LANE_ROWS, own._id, { lastActivityAt: NOW });
  s.patch(PRESENCE, own.presenceRow.id, { at: NOW });
  s.patch(LANE_ROWS, template._id, { lastActivityAt: cutoff - 10 });
  s.patch(PRESENCE, template.presenceRow.id, { at: cutoff - 10 });
  const addPresence = (laneId, lastActivityAt, at, status) => {
    seedLane(s, template, laneId, { changes: '[]', lastActivityAt }, status);
    s.insert(PRESENCE, {
      projectId: s.projectId,
      laneId,
      intentId: template.intentId,
      actor: template.actor,
      goal: 'Synthetic dormant presence',
      paths: [],
      pathCount: 0,
      at,
    });
  };

  // Activity crossed the cutoff, but the previous presence timestamp is still within its refresh interval.
  for (let i = 0; i < 20; i++) addPresence(`near-${i}`, cutoff + 1, cutoff - 1);
  const single = await readBoth(s, mine.id, { path: 'a.txt' });
  t.diagnostic(
    `one dormant unmatched head: before ${JSON.stringify(readCost(single.baseline))} after ${JSON.stringify(readCost(single))}`,
  );
  assert.equal(single.reply.peerEvidence.coverage, 'hosted');

  addPresence('paused-live', NOW, NOW, 'paused');
  const withPausedPeer = await readBoth(s, mine.id, { detail: true });
  assert.equal(withPausedPeer.reply.peerEvidence.coverage, 'hosted');
  assert.equal(
    withPausedPeer.io.readRangesByTable[HEADS],
    withPausedPeer.baseline.io.readRangesByTable[HEADS],
  );
  assert.equal(readCost(withPausedPeer).presenceRows, readCost(withPausedPeer.baseline).presenceRows);

  // Paused and ready Lanes retain presence but do not appear in the active-head window. They can
  // fill the legacy dormant window and age the one unmatched active head out of it.
  for (let i = 0; i < 102; i++)
    addPresence(`paused-${i}`, cutoff - 1, cutoff - 1, i % 2 ? 'paused' : 'ready');
  const capped = await readBoth(s, mine.id, { path: 'a.txt' });
  assert.equal(capped.reply.peerEvidence.coverage, 'hosted-incomplete');
  for (const table of [PRESENCE, LANE_ROWS, HEADS])
    for (const row of s.tables[table].values())
      if ((row.laneId ?? row.key).startsWith('paused-')) s.tables[table].delete(row._id);

  for (let i = 0; i < 16; i++) addPresence(`dormant-${i}`, cutoff - 2, cutoff - 2);
  const wide = await readBoth(s, mine.id, { path: 'a.txt' });
  assert.equal(wide.wire, single.wire);
  assert.equal(readCost(wide).presenceRows, 37);
  assert.equal(readCost(single).presenceRows, 1);
});

test('path pruning preserves ordered matches, incomplete coverage, and board claims on related Lanes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { s, lane: mine, peer } = await setup(t);
  const path = 'z-match.txt';
  const match = delta(path, 903);
  await trackChange(s, peer, [...sweep(50), match], 'Match beyond the slim list');
  const template = rowOf(s, peer.id);
  assert(!template.pathSummary.paths.includes(path));
  assert(presenceMayShare(template.pathSummary, new Set([path])));
  s.patch(LANE_ROWS, template._id, {
    superseded: {
      by: 'landed-lane',
      receiptId: 'landed-receipt',
      laneHead: template.head,
      at: '2026-10-01T12:00:00Z',
    },
  });

  const changes = boundOverlapChanges([match, ...sweep(50, 'other')]);
  seedLane(s, template, 'stack-peer', { ...changes, stackRoot: mine.id });
  seedLane(s, template, 'resolution-peer', { ...changes, resolutionOrigin: mine.id });
  seedLane(s, template, 'second-match', { ...changes, lastActivityAt: NOW });
  const capped = boundOverlapChanges(sweep(900, 'capped'));
  assert.equal(capped.complete, false);
  const cappedId = seedLane(s, template, 'capped-peer', capped);
  assert(!presenceMayShare(s.tables[LANE_ROWS].get(cappedId).pathSummary, new Set([path])));

  const claim = laneId =>
    s.insert('projectBoardClaims', {
      projectId: s.projectId,
      laneId,
      path,
      author: 'owner',
      at: NOW,
      expiresAt: NOW + 10_000,
    });
  claim('stack-peer');
  claim('capped-peer');
  const args = { path, board: { after: 0, claim: true } };
  const { reply } = await readBoth(s, mine.id, args);
  assert.equal(reply.peerEvidence.count, 2);
  assert.equal(reply.peerEvidence.coverage, 'hosted-incomplete', 'the unrelated capped peer still counts');
  assert.deepEqual(
    reply.peerEvidence.items.map(item => item.lanes.find(id => id !== mine.id)),
    ['second-match', peer.id],
  );
  assert.equal(reply.peerEvidence.items[1].superseded, true);
  assert.deepEqual(
    reply.board.touching.map(item => item.fromLaneId),
    ['capped-peer'],
  );
  assert.equal(reply.board.claim, 'send');
});

test('staged, applied and materialized lifecycle plans preserve path advice and exact conflict delivery', async t => {
  const { s, lane: mine, peer } = await setup(t);
  const path = 'a.txt';
  await trackChange(s, peer, [delta(path)], 'Peer');
  const template = rowOf(s, peer.id);
  const lifecyclePlanId = s.insert('projectHostedLifecyclePlans', {
    projectId: s.projectId,
    actor: 'owner',
    operationId: 'cascade',
    receiptId: 'cascade',
    intentId: peer.intentId,
    authorityEpoch: 1,
    request: '{}',
    at: '2026-10-01T12:00:00Z',
    revision: 1,
    status: 'pending',
    cursor: null,
    staged: 1,
    ready: true,
    saveOperationId: null,
    savedExpected: null,
    materialized: false,
    appliedThrough: 0,
    materializeCursor: null,
  });
  s.patch(LANE_ROWS, template._id, { lifecyclePlanId });
  s.insert('projectHostedConflictNotices', {
    projectId: s.projectId,
    laneId: mine.id,
    peer: 'main',
    peerGoal: 'Main',
    open: true,
    paths: [{ path, mine: [], theirs: [], reason: 'content' }],
    laneHead: mine.head,
    peerHead: hex(900),
    flaggedAt: 12,
    updatedAt: 12,
    laneStartedAt: 0,
  });
  const staged = await readBoth(s, mine.id, { path });
  assert.equal(staged.reply.peerEvidence.count, 1);
  assert.equal(staged.reply.conflicts[0].files[0].path, path);
  s.patch('projectHostedLifecyclePlans', lifecyclePlanId, { status: 'applied' });
  const applied = await readBoth(s, mine.id, { path });
  assert.equal(applied.reply.peerEvidence.count, 0);
  assert.deepEqual(applied.reply.conflicts, staged.reply.conflicts);
  s.patch(LANE_ROWS, template._id, { open: false, lifecyclePlanId: undefined });
  const head = [...s.tables[HEADS].values()].find(row => row.key === peer.id);
  s.patch(HEADS, head._id, { status: 'abandoned' });
  assert.equal((await readBoth(s, mine.id, { path })).wire, applied.wire);
});
