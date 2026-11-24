// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-overlaps-fixture.mjs';
import { hostedOverlapAdvice, mergeOverlapChanges, boundOverlapChanges } from '../dist/hosted-overlap.js';
import { lineBaseTag } from '../dist/hosted-overlap-evidence.js';

// Item 411727ba, Fable verdict dc29dc4f: a Lane's saved change entries live in 64 hash buckets, so the first-write
// hook's peer read loads one bucket per peer instead of every peer's whole list (621 KB with sweep-size peers).
const buckets = await import(moduleUrl('../convex/projectHostedOverlapChanges.ts'));
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));

const hex = n => digest(`blob-${n}`);
const prng = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** A synthetic saved change; `links` adds cross-file symbol facts. */
const entry = (path, n, links) => ({
  path,
  before: { blob: hex(n), mode: 'file' },
  after: { blob: hex(n + 1), mode: 'file' },
  evidence: {
    baseBlob: hex(n),
    ranges: [{ start: n % 7, end: (n % 7) + 2 }],
    symbols: [`name${n}`],
    ...(links ? { symbolLinks: links } : {}),
  },
  lines: [n % 9, n % 4, lineBaseTag(hex(n))],
});
const pathOf = (i, rand) =>
  `${['src', 'web/src', 'convex', 'docs/é', 'tests'][Math.floor(rand() * 5)]}/f${i}.ts`;
const listOf = (size, seed, links) => {
  const rand = prng(seed);
  return mergeOverlapChanges(
    [],
    Array.from({ length: size }, (_, i) => entry(pathOf(i, rand), i, links?.(i))),
  );
};
const parts = list => [...buckets.splitOverlapChanges(list).values()];

test('a Lane list split into path buckets joins back to the exact string every reader parsed (reassembly)', () => {
  for (const [size, seed] of [
    [0, 1],
    [1, 2],
    [7, 3],
    [64, 4],
    [300, 5],
    [900, 6],
  ]) {
    const { changes } = listOf(size, seed);
    const split = buckets.splitOverlapChanges(changes);
    assert(split.size <= buckets.OVERLAP_BUCKETS);
    for (const [bucket, text] of split)
      for (const change of JSON.parse(text)) assert.equal(buckets.overlapBucket(change.path), bucket);
    assert.equal(buckets.joinOverlapBuckets([...split.values()]), changes, `size ${size}`);
  }
});

test('paths that collate equally keep one order in the inline and the bucketed list', () => {
  const list = mergeOverlapChanges([], [entry('\u00e9.txt', 1), entry('e\u0301.txt', 2), entry('z.txt', 3)]);
  const split = buckets.splitOverlapChanges(list.changes);
  assert.equal(buckets.joinOverlapBuckets([...split.values()].reverse()), list.changes);
  assert.equal(buckets.joinOverlapBuckets([...split.values()]), list.changes);
});

test('boundOverlapChanges returns its own output unchanged, so a same-head write needs no bucket read or write', () => {
  for (const [size, seed] of [
    [3, 11],
    [200, 12],
    [450, 13],
    [900, 14],
  ]) {
    for (const links of [undefined, i => ({ exports: [`e${i}`], refs: [`src/f${i + 1}.ts#e${i}`] })]) {
      const first = listOf(size, seed, links);
      assert.deepEqual(boundOverlapChanges(JSON.parse(first.changes), first.complete), first, `size ${size}`);
      assert.deepEqual(mergeOverlapChanges(JSON.parse(first.changes), [], first.complete), first);
    }
  }
});

/** A Lane as the advice function reads it. */
const lane = (laneId, list, extra = {}) => ({
  laneId,
  intentId: `intent-${laneId}`,
  intent: `Lane ${laneId}`,
  actor: `actor-${laneId}`,
  head: digest(`head-${laneId}`),
  baseHead: digest('base'),
  baseSequence: 0,
  open: true,
  changes: list.changes,
  complete: list.complete,
  ...extra,
});

test('advice reads the same peers whether a peer holds its whole list or only the entries this read can use', () => {
  const current = { head: digest('base'), sourceRevision: 0 };
  const rand = prng(21);
  for (const withFacts of [false, true]) {
    // Mine uses symbols that peers 1 and 2 export from files mine did not save.
    const links = withFacts
      ? i => ({ exports: [`e${i}`], refs: ['peer1/own7.ts#e10', 'peer2/own9.ts#e12'] })
      : undefined;
    const mine = listOf(30, 31, links);
    const mineLane = lane('mine', mine);
    const mineSaved = new Set(JSON.parse(mine.changes).map(change => change.path));
    const peers = Array.from({ length: 4 }, (_, k) =>
      // Peers 0 and 3 share some of mine's paths; 1 and 2 share none (their link to mine is a symbol).
      lane(`peer${k}`, {
        ...mergeOverlapChanges(
          [],
          [
            ...JSON.parse(mine.changes)
              .filter(() => (k === 1 || k === 2 ? false : rand() < 0.4))
              .map(change => ({ ...change, after: { blob: hex(900 + k), mode: 'file' } })),
            ...Array.from({ length: 60 }, (_, i) => entry(`peer${k}/own${i}.ts`, 50 + i, links?.(i + 3))),
          ],
        ),
      }),
    );
    const some = JSON.parse(peers[0].changes).find(change => mineSaved.has(change.path)).path;
    const bothHaveFacts = withFacts && buckets.hasSymbolFacts(mine.changes);
    for (const mode of ['default', 'path', 'detail', 'scope']) {
      const view = peer => {
        const full = peer.changes;
        if (mode === 'path') return buckets.filterOverlapEntries(full, new Set([some]));
        if (mode === 'default')
          return bothHaveFacts && buckets.hasSymbolFacts(full)
            ? full
            : buckets.filterOverlapEntries(full, mineSaved);
        return full;
      };
      const args = mode === 'path' ? [some] : [undefined];
      const run = rows =>
        hostedOverlapAdvice(
          mineLane,
          rows,
          null,
          current,
          true,
          50,
          args[0],
          undefined,
          mode === 'scope' ? ['src/'] : undefined,
        );
      const whole = run(peers);
      const subset = run(peers.map(peer => ({ ...peer, changes: view(peer) })));
      assert.deepEqual(subset, whole, `${mode}, facts ${withFacts}`);
      if (mode === 'path') assert(whole.overlaps.count > 0, 'the requested path is shared');
    }
    if (withFacts) {
      // The reason the whole list stays for symbol facts: a note can rest on an entry of a path mine did not save.
      const notes = hostedOverlapAdvice(mineLane, peers, null, current, true, 50).overlaps.items.filter(
        item => item.reason === 'cross-file-symbol',
      );
      assert(notes.length > 0, 'the fixture produces cross-file notes');
    }
  }
});

const delta = (path, n = 1) => entry(path, n);
const trackChange = (s, who, paths, intent) =>
  s.transaction(
    'track-change',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'lane',
          key: who.id,
        });
        const current = JSON.parse(row.value);
        await records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: {
            ...current,
            head: String(current.version + 1).padStart(64, 'e'),
            version: current.version + 1,
            sourceVersion: current.sourceVersion + 1,
          },
          overlap: { baseSequence: 0, intent, changes: paths },
        });
      },
    },
    {},
  );
const read = async (s, laneId, args) => {
  const reply = JSON.parse(
    await s.transaction('projectHostedOverlaps:read', overlaps.read, {
      projectId: s.projectId,
      laneId,
      ...args,
    }),
  );
  return { reply, io: s.counts.at(-1) };
};
const rowOf = (s, laneId) =>
  [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
const bucketRows = (s, laneId) =>
  [...s.tables.projectHostedOverlapChanges.values()].filter(row => row.laneId === laneId);
const sweep = (count, tag = 'sweep') =>
  Array.from({ length: count }, (_, i) => delta(`${tag}/file-${i}.txt`, i));
test('hook read: a sweep-size peer costs one bucket, not its whole list', async t => {
  const { s, lane: mine, peer } = await setup(t);
  await trackChange(s, peer, [...sweep(540), delta('a.txt', 900)], 'Peer sweep');
  await trackChange(s, mine, [delta('a.txt', 901), delta('sweep/file-3.txt', 902)], 'My change');
  const slim = rowOf(s, peer.id);
  assert(bucketRows(s, peer.id).length > 30, 'its entries are spread over the buckets');
  assert.equal(slim.pathSummary.pathCount, 541);
  assert(JSON.stringify(slim).length < 3_000, `slim row ${JSON.stringify(slim).length} B`);
  const whole = buckets.joinOverlapBuckets(bucketRows(s, peer.id).map(bucket => bucket.changes)).length;
  const { reply, io } = await read(s, mine.id, { path: 'a.txt' });
  t.diagnostic(`hook read ${io.readBytes} B; the peer's whole list is ${whole} B`);
  assert(io.readBytes * 5 < whole, `hook read ${io.readBytes} B against a ${whole} B peer list`);
  assert.equal(reply.peerEvidence.count, 1);
});

/** Oracle for the bucket-only reader: the same query, but every bucket lookup returns the peer's whole list, so the
 * path filter alone decides which entries each mode sees (the reply the whole inline list gave). */
const over = (target, overrides) =>
  new Proxy(target, {
    get: (object, key) => {
      if (key in overrides) return overrides[key];
      const value = object[key];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
const wholeListDb = db =>
  over(db, {
    query: table => {
      const base = db.query(table);
      if (table !== 'projectHostedOverlapChanges') return base;
      return over(base, {
        withIndex: (index, build) => {
          let pointed = false;
          const wrap = target =>
            over(target, {
              eq: (key, value) =>
                key === 'bucket' ? ((pointed = true), wrap(target)) : wrap(target.eq(key, value)),
            });
          const inner = base.withIndex(index, q => build(wrap(q)));
          if (!pointed) return inner;
          return over(inner, {
            unique: async () => ({
              changes: buckets.joinOverlapBuckets((await inner.take(64)).map(row => row.changes)),
            }),
          });
        },
      });
    },
  });
const wholeListRead = async (s, laneId, args) =>
  JSON.parse(
    await s.transaction(
      'projectHostedOverlaps:read',
      {
        ...overlaps.read,
        _handler: (ctx, input) => overlaps.read._handler(over(ctx, { db: wholeListDb(ctx.db) }), input),
      },
      { projectId: s.projectId, laneId, ...args },
    ),
  );

test('every read mode answers as the whole saved list does (bucket selection parity)', async t => {
  const { s, lane: mine, peer } = await setup(t);
  await trackChange(s, peer, [...sweep(540), delta('a.txt', 900), delta('b/two.txt', 903)], 'Peer sweep');
  await trackChange(
    s,
    mine,
    [delta('a.txt', 901), delta('sweep/file-3.txt', 902), delta('b/two.txt', 904)],
    'My change',
  );
  const modes = [
    {},
    { path: 'a.txt' },
    { path: 'sweep/file-3.txt' },
    { path: 'not-saved.txt' },
    { detail: true },
    { scope: ['sweep/'] },
    { scope: ['b/', 'a.txt'] },
    { paths: true },
  ];
  const bucketed = [];
  for (const mode of modes) bucketed.push((await read(s, mine.id, mode)).reply);
  for (const [i, mode] of modes.entries())
    assert.deepEqual(bucketed[i], await wholeListRead(s, mine.id, mode), `reply of ${JSON.stringify(mode)}`);
});

test('the hook read does not grow with the peer: 5 files and 540 files read about the same', async t => {
  const costs = [];
  for (const size of [5, 540]) {
    const { s, lane: mine, peer } = await setup(t);
    await trackChange(s, peer, [...sweep(size), delta('a.txt', 900)], 'Peer');
    await trackChange(s, mine, [delta('a.txt', 901)], 'Mine');
    costs.push((await read(s, mine.id, { path: 'a.txt' })).io.readBytes);
  }
  t.diagnostic(`hook read bytes by peer size: ${costs.join(' / ')}`);
  assert(Math.abs(costs[1] - costs[0]) < 3_000, `peer growth moved the read by ${costs[1] - costs[0]} B`);
});

test('replaying identical pending overlap evidence writes no subscribed row; restoring it still changes advice', async t => {
  const { s, lane: mine, peer } = await setup(t);
  const update = async (metadata, record = peer) => {
    await s.transaction(
      'pending-overlap',
      { _handler: ctx => tracking.trackHostedOverlapLane(ctx, s.projectId, record, metadata) },
      {},
    );
    return s.counts.at(-1);
  };
  const pending = { pending: true, changes: [delta('a.txt', 9)] };
  const first = await update(pending);
  assert(first.writeBytesByTable.projectHostedOverlapLanes > 0);
  const before = await read(s, mine.id, { path: 'a.txt' });
  assert.equal(before.reply.peerEvidence.count, 1);

  const replay = await update(pending);
  const replayBytes = replay.writeBytesByTable.projectHostedOverlapLanes ?? 0;
  t.diagnostic(`identical pending replay: ${replay.readBytes} B read; ${replayBytes} B slim row written`);
  assert.equal(replayBytes, 0);
  assert.equal(replay.writeBytesByTable.projectHostedOverlapChanges ?? 0, 0);
  assert.deepEqual((await read(s, mine.id, { path: 'a.txt' })).reply, before.reply);

  // A missing Live Line marker is still repaired; the overlap no-op must not return early.
  const mark = [...s.tables.projectLiveLineLanes.values()].find(row => row.laneId === peer.id);
  const owner = [...s.tables.projectFinishReadRows.values()].find(
    row => row.kind === 'projectLiveLineOwner' && row.sourceId === peer.id,
  );
  s.tables.projectLiveLineLanes.delete(mark._id);
  s.tables.projectFinishReadRows.delete(owner._id);
  const repaired = await update(pending);
  assert.equal(repaired.writeBytesByTable.projectHostedOverlapLanes ?? 0, 0);
  assert([...s.tables.projectLiveLineLanes.values()].some(row => row.laneId === peer.id));

  const restored = await update({ restorePending: [] });
  assert(restored.writeBytesByTable.projectHostedOverlapLanes > 0);
  assert.equal(rowOf(s, peer.id).settled, undefined);
  assert.equal((await read(s, mine.id, { path: 'a.txt' })).reply.peerEvidence.count, 0);

  // A record pin change alone may not be skipped even when head, paths and activity stay the same.
  const version = peer.version + 1;
  const pinned = await update(undefined, { ...peer, version });
  assert(pinned.writeBytesByTable.projectHostedOverlapLanes > 0);
  assert.equal(pinned.readDocumentsByTable.projectHostedOverlapChanges ?? 0, 0);
  assert.equal(rowOf(s, peer.id).head, peer.head);
  assert.equal(rowOf(s, peer.id).recordVersion, version);
  assert.equal(rowOf(s, peer.id).lastActivityAt, Date.parse(peer.at));

  const at = '2026-10-01T12:00:00.000Z';
  await update(undefined, { ...peer, version, at });
  assert.equal(rowOf(s, peer.id).lastActivityAt, Date.parse(at));
});

test('a record write that keeps the saved list touches no bucket; a save of one path rewrites only its bucket', async t => {
  const { s, lane: mine, peer } = await setup(t);
  await trackChange(s, peer, sweep(300), 'Peer sweep');
  const start = bucketRows(s, peer.id)
    .map(row => `${row.bucket}:${row.changes}`)
    .sort();
  // Same head, same base, nothing new: the Lane record is written again (activity, intent text).
  await s.transaction(
    'rewrite',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'lane',
          key: peer.id,
        });
        await tracking.trackHostedOverlapLane(ctx, s.projectId, JSON.parse(row.value), { intent: 'Renamed' });
      },
    },
    {},
  );
  const io = s.counts.at(-1);
  assert.equal(io.readDocumentsByTable.projectHostedOverlapChanges ?? 0, 0, 'no bucket read');
  assert.equal(io.writeBytesByTable.projectHostedOverlapChanges ?? 0, 0, 'no bucket written');
  assert.deepEqual(
    bucketRows(s, peer.id)
      .map(row => `${row.bucket}:${row.changes}`)
      .sort(),
    start,
  );
  assert.equal(rowOf(s, peer.id).intent, 'Renamed');
  // A new head that adds one path rewrites one bucket (and the slim row), not the list.
  await trackChange(s, peer, [delta('one/more.txt', 77)], 'Peer sweep');
  const save = s.counts.at(-1);
  t.diagnostic(`save of one path wrote ${JSON.stringify(save.writeBytesByTable)}`);
  assert(save.writeBytesByTable.projectHostedOverlapChanges < 12_000);
  assert(save.writeBytesByTable.projectHostedOverlapLanes < 4_000);
  assert.equal(rowOf(s, peer.id).pathSummary.pathCount, 301);
});
