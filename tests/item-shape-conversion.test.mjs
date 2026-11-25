// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item c0af6cfa F7 and F8: an Item's Lanes and landings are read through the Intent and Lane bindings and the
// landing notes alone. Rows from before those shapes (a head with no Item binding, a Lane with only its overlap
// stamp) are converted once by convex/legacyItemShapes.ts; nothing reads the old shapes afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { itemWorkFixture as fixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
const convert = await import(moduleUrl('../convex/legacyItemShapes.ts'));
const heads = await import(moduleUrl('../convex/projectItemIntentHeads.ts'));
const at = '2026-01-01T00:00:00.000Z';
const deployment = 'benevolent-wildebeest-974';

function dev(t, url = 'https://benevolent-wildebeest-974.convex.cloud') {
  const before = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = url;
  t.after(() => {
    if (before === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = before;
  });
}

const headOf = (s, key) => [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === key);
const runFamily = async (s, family, apply) => {
  const total = {};
  let cursor = null;
  do {
    const result = await s.call(`convert-${family}`, convert.page, {
      deployment,
      projectId: s.auth.projectId,
      family,
      cursor,
      apply,
    });
    for (const [key, value] of Object.entries(result.counts)) total[key] = (total[key] ?? 0) + value;
    cursor = result.next;
  } while (cursor);
  return total;
};

/** What the old writers left: unbound heads, an unbound successor Intent, and a landing that only the overlap
 * row's stamp remembers (the fixture's stamped Lane, whose note this test removes). */
async function legacyItem(t) {
  dev(t);
  const s = await fixture({ details: true });
  // The planned Item itself: the conversion binds a same-id Intent only to an Item that exists.
  await s.ctx.db.insert('projectHostedRecordHeads', {
    projectId: s.auth.projectId,
    kind: 'issue',
    key: s.itemId,
    parent: '',
    version: 1,
    status: 'open',
    recordId: [...s.tables.projectHostedRecords.keys()][0],
  });
  const successor = successorIntentId(s.itemId);
  await s.put(
    {
      kind: 'intent',
      id: successor,
      version: 0,
      at,
      outcome: 'Follow-up work',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: 'a'.repeat(64), receiptId: randomUUID() },
      status: 'active',
    },
    null,
  );
  const followUpLane = { ...s.open, id: randomUUID(), intentId: successor };
  await s.put(followUpLane, null);
  for (const key of [s.itemId, successor, followUpLane.id])
    await s.ctx.db.patch(headOf(s, key)._id, { planningItemId: undefined });
  for (const lane of [s.open, s.noted, s.stamped, s.abandoned])
    await s.ctx.db.patch(headOf(s, lane.id)._id, { planningItemId: undefined });
  const note = [...s.tables.projectIntentLandingNotes.values()].find(row => row.receiptId === s.stampReceipt);
  await s.ctx.db.delete(note._id);
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.stamped.id);
  const stamp = { receiptId: s.stampReceipt, commit: 'd'.repeat(64), laneHead: 'b'.repeat(64), at };
  if (overlap) await s.ctx.db.patch(overlap._id, { landed: stamp });
  else
    await s.ctx.db.insert('projectHostedOverlapLanes', {
      lastActivityAt: 4_000_000_000_000,
      projectId: s.auth.projectId,
      laneId: s.stamped.id,
      intentId: s.itemId,
      actor: 'owner',
      head: 'b'.repeat(64),
      baseHead: 'a'.repeat(64),
      baseReceiptId: randomUUID(),
      baseSequence: 1,
      recordVersion: 0,
      open: false,
      pathSummary: { paths: [], pathCount: 0 },
      complete: true,
      landed: stamp,
    });
  await s.ctx.db.insert('projectHostedAcceptances', {
    projectId: s.auth.projectId,
    receiptId: s.stampReceipt,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 41,
    value: JSON.stringify({
      at,
      snapshot: { revision: 41 },
      candidate: { id: randomUUID(), head: 'd'.repeat(64) },
    }),
  });
  return { s, successor, followUpLane };
}

test('an Item is its bound Intents and Lanes: an unbound same-id head is not read as the Item’s', async t => {
  const { s } = await legacyItem(t);
  assert.equal(await heads.latestItemIntentHead(s.ctx, s.auth.projectId, s.itemId), null);
  const work = await s.read();
  assert.deepEqual(work.lanes, [], 'an unbound Lane is not listed');
});

test('the conversion binds roots, successors and Lanes, writes the missing landing note, and a replay changes nothing', async t => {
  const { s, successor, followUpLane } = await legacyItem(t);
  const dry = {
    ...(await runFamily(s, 'intents', false)),
    ...(await runFamily(s, 'lanes', false)),
  };
  assert.equal(dry.rootsBound, 1);
  assert.equal(dry.successorsBound, 1);
  assert.equal(dry.lanesUnmarked, 5, 'four Lanes of the root and one of the successor');
  assert.equal(headOf(s, s.itemId).planningItemId, undefined, 'a dry run writes nothing');
  assert.equal(s.counts.at(-1).writes, 0);

  await runFamily(s, 'intents', true);
  assert.equal((await runFamily(s, 'lanes', true)).lanesBound, 5);
  assert.equal(headOf(s, s.itemId).planningItemId, s.itemId);
  assert.equal(headOf(s, successor).planningItemId, s.itemId);
  assert.equal(headOf(s, followUpLane.id).planningItemId, s.itemId);
  // Landings follow the bindings: only a stamp on an Item-bound Intent without its note counts.
  assert.equal((await runFamily(s, 'landings', false)).landedNotesMissing, 1);
  assert.equal([...s.tables.projectIntentLandingNotes.values()].length, 1, 'a dry run writes nothing');
  assert.equal((await runFamily(s, 'landings', true)).landedNotesWritten, 1);

  const work = await s.read({ limit: 20 });
  const byLane = Object.fromEntries(work.lanes.map(lane => [lane.laneId, lane]));
  assert(byLane[s.open.id] && byLane[followUpLane.id]);
  // The landing the stamp remembered now reads from its note with the stamp's own receipt, commit and time.
  assert.deepEqual(
    [
      byLane[s.stamped.id].receipt.receiptId,
      byLane[s.stamped.id].receipt.commit,
      byLane[s.stamped.id].receipt.at,
    ],
    [s.stampReceipt, 'd'.repeat(64), at],
  );
  assert.equal(byLane[s.stamped.id].receipt.sequence, 41);

  // Replay: every converted count is zero.
  for (const family of ['intents', 'lanes', 'landings']) {
    const again = await runFamily(s, family, true);
    for (const key of [
      'rootsBound',
      'successorsBound',
      'lanesBound',
      'landedNotesMissing',
      'landedNotesWritten',
    ])
      assert.equal(again[key] ?? 0, 0, `${family} ${key}`);
  }
});

test('the conversion never takes another Item’s Intent and reports an Item stamp it cannot back with a receipt', async t => {
  const { s, successor } = await legacyItem(t);
  const foreign = randomUUID();
  await s.ctx.db.patch(headOf(s, successor)._id, { planningItemId: foreign });
  await runFamily(s, 'intents', true);
  assert.equal(headOf(s, successor).planningItemId, foreign, 'a foreign binding is authoritative');
  for (const row of [...s.tables.projectHostedAcceptances.values()])
    if (row.receiptId === s.stampReceipt) s.tables.projectHostedAcceptances.delete(row._id);
  const result = await s.call('blocked', convert.page, {
    deployment,
    projectId: s.auth.projectId,
    family: 'landings',
    cursor: null,
    apply: true,
  });
  assert.deepEqual(result.blocked, [s.stamped.id]);
  assert.equal(result.counts.landedNotesWritten, undefined);
});

test('the conversion refuses when its deployment argument does not name the deployment it runs on', async t => {
  const { s } = await legacyItem(t);
  dev(t, 'https://fixture-prod.convex.cloud');
  const call = name =>
    s.call('refused', convert.page, {
      deployment: name,
      projectId: s.auth.projectId,
      family: 'intents',
      cursor: null,
      apply: true,
    });
  await assert.rejects(call(deployment), error => error.code === 'PROJECT_UNAVAILABLE');
  assert.equal((await call('fixture-prod')).counts.rootsBound, 1, 'the named deployment may run it');
});

test('a note that names only one of two Lanes of a receipt gains the other; a revert note carries the revert’s own evidence', async t => {
  const { s, successor } = await legacyItem(t);
  await runFamily(s, 'intents', true);
  await runFamily(s, 'lanes', true);
  // A second Lane of the same Intent landed under the same receipt and kept only its stamp.
  const sibling = { ...s.stamped, id: randomUUID() };
  await s.put(sibling);
  const first = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.stamped.id);
  const revert = { receiptId: randomUUID(), at: '2026-01-02T00:00:00.000Z' };
  await s.ctx.db.patch(first._id, { landed: { ...first.landed, revertedBy: revert } });
  await s.ctx.db.insert('projectHostedOverlapLanes', {
    ...Object.fromEntries(Object.entries(first).filter(([key]) => !key.startsWith('_'))),
    laneId: sibling.id,
    landed: first.landed,
  });
  await s.ctx.db.insert('projectHostedAcceptances', {
    projectId: s.auth.projectId,
    receiptId: revert.receiptId,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 44,
    value: JSON.stringify({
      at: revert.at,
      snapshot: { revision: 44 },
      candidate: { id: randomUUID(), head: 'e'.repeat(64) },
    }),
  });
  const written = await runFamily(s, 'landings', true);
  assert.equal(written.landedNotesWritten, 2, 'the stamped Lane’s note and the sibling’s merge into one');
  const notes = [...s.tables.projectIntentLandingNotes.values()].filter(
    row => row.receiptId === s.stampReceipt,
  );
  assert.equal(notes.length, 1);
  assert.deepEqual([...notes[0].laneIds].sort(), [s.stamped.id, sibling.id].sort());
  const reverted = [...s.tables.projectIntentLandingNotes.values()].find(row => row.kind === 'reverted');
  assert.deepEqual(
    [reverted.receiptId, reverted.revertOf, reverted.commit, reverted.sequence, reverted.at],
    [revert.receiptId, s.stampReceipt, 'e'.repeat(64), 44, revert.at],
  );
  const again = await runFamily(s, 'landings', true);
  assert.equal(again.landedNotesMissing ?? 0, 0);
  assert.equal(again.stampsUnproved ?? 0, 0);
  assert(again.stampsProved >= 2);
  void successor;
});
