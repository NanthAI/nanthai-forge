// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0f76b07e line 7, friction b5e8e2d5: a sync conflict of the caller's own live resolution Lane
// takes the new draft in that Lane (same id, chain's first origin) instead of drafting a sibling
// resolution Lane per hop. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { canonicalRoot } from '../dist/root-paths.js';

const onto = (head, receiptId) => ({ kind: 'main', head, receiptId });
// One row per record version: count Lane identities.
const laneIds = s =>
  new Set([...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'lane').map(row => row.key));

/** Lane a conflicts with main; its sync drafts resolution Lane R1 (origin a); main then moves again. */
async function chain() {
  const s = await syncFixture(),
    { a } = await s.conflict();
  const main1 = s.state([s.file('a.txt', 'main\n'), s.hidden], [s.baseline.sha256]);
  s.moveMain(main1.sha256, 'main-1');
  const first = (
    await s.execute(
      s.request('sync', { laneId: a.laneId, expected: s.pins(a), target: onto(main1.sha256, 'main-1') }),
    )
  ).terminal.outcome.result;
  assert.equal(first.status, 'conflict');
  assert.notEqual(first.lane.laneId, a.laneId, 'the first hop still drafts beside the original Lane');
  const main2 = s.state([s.file('a.txt', 'main2\n'), s.hidden], [main1.sha256]);
  s.moveMain(main2.sha256, 'main-2');
  return { s, a, r1: first.lane.laneId, main2 };
}

for (const resolved of [false, true])
  test(`b5e8e2d5: a conflicting sync of a ${resolved ? 'resolved' : 'pending'} resolution Lane takes the new draft in that Lane, origin kept`, async () => {
    const { s, a, r1, main2 } = await chain();
    let entry = await s.save((await s.readLane(r1)).entry, [s.file('a.txt', 'chosen\n'), s.hidden]);
    if (resolved) {
      await s.execute(s.request('resolve', { laneId: r1, expected: s.pins(entry) }));
      entry = (await s.readLane(r1)).entry;
      assert.equal((await s.readLane(r1)).record.resolution.status, 'resolved');
    }
    const lanesBefore = laneIds(s).size;
    const result = (
      await s.execute(
        s.request('sync', {
          laneId: r1,
          expected: s.pins(entry),
          reuseResolution: true,
          target: onto(main2.sha256, 'main-2'),
        }),
      )
    ).terminal.outcome.result;
    assert.equal(result.status, 'conflict');
    assert.equal(result.lane.laneId, r1, 'the resolution of a resolution keeps the live Lane id');
    assert.equal(result.from.laneId, r1);
    assert.equal(laneIds(s).size, lanesBefore, 'no second resolution Lane record');
    const { record } = await s.readLane(r1);
    assert.equal(record.version, entry.version + 1);
    assert.equal(record.sourceVersion, entry.sourceVersion + 1);
    assert.equal(record.head, result.lane.head);
    assert.equal(record.state, 'active');
    assert.equal(record.resolution.status, 'pending');
    assert.equal(record.resolution.candidateId, null);
    assert.equal(record.resolution.left, entry.head);
    assert.equal(record.resolution.right, main2.sha256);
    assert.equal(record.resolution.draftHead, record.head);
    assert.equal(record.resolution.origin.laneId, a.laneId, 'landing it still completes the first Lane');
    assert.equal((await s.readLane(a.laneId)).entry.head, a.head, 'the original Lane is unchanged');
    // The same Lane resolves the new draft and stays one Lane.
    const saved = await s.save((await s.readLane(r1)).entry, [s.file('a.txt', 'final\n'), s.hidden]);
    const done = await s.execute(s.request('resolve', { laneId: r1, expected: s.pins(saved) }));
    assert.equal(done.terminal.outcome.result.status, 'resolved');
    assert.equal(done.terminal.outcome.result.lane.laneId, r1);
    assert.deepEqual(JSON.parse(s.objects.get((await s.readLane(r1)).record.head)).parents, [
      saved.head,
      main2.sha256,
    ]);
  });

test('b5e8e2d5: a retried sync of a reused resolution Lane replays its first receipt and writes the Lane once', async () => {
  const { s, r1, main2 } = await chain();
  const entry = (await s.readLane(r1)).entry;
  const r = s.request('sync', {
    laneId: r1,
    expected: s.pins(entry),
    reuseResolution: true,
    target: onto(main2.sha256, 'main-2'),
  });
  const { terminal } = await s.execute(r);
  assert.equal(terminal.outcome.result.lane.laneId, r1);
  assert.deepEqual((await s.prepareSync(r)).terminal, terminal, 'a retry never writes the Lane twice');
  assert.equal((await s.readLane(r1)).record.version, entry.version + 1);
});

test('b5e8e2d5: a client that does not ask for reuse still gets a sibling resolution Lane', async () => {
  const { s, r1, main2 } = await chain();
  const entry = (await s.readLane(r1)).entry;
  const result = (
    await s.execute(
      s.request('sync', { laneId: r1, expected: s.pins(entry), target: onto(main2.sha256, 'main-2') }),
    )
  ).terminal.outcome.result;
  assert.equal(result.status, 'conflict');
  assert.notEqual(result.lane.laneId, r1, 'an older client keeps the sibling it understands');
  assert.equal(
    (await s.readLane(r1)).record.version,
    entry.version,
    'the first resolution Lane is untouched',
  );
  assert.equal((await s.readLane(result.lane.laneId)).record.resolution.status, 'pending');
});

/** Main moves again with a new a.txt, keeping every other file of the current main. */
function moveMainAgain(f, text) {
  const old = f.currentMain(),
    files = JSON.parse(f.c.objects.get(old.head)).files.filter(file => file.path !== 'a.txt');
  const state = f.c.state([...files, f.c.file('a.txt', text)], [old.head]);
  f.c.register(state);
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...old, head: state.sha256, receipt: { ...old.receipt, id: randomUUID() } }),
  });
}
const strip = ({ action, ...parameters }) => [action, parameters];

test('b5e8e2d5 incident replay: a second conflict in the resolution folder stays in the same folder and Lane, resolves and lands once', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f,
    root = s.root;
  f.moveMain({ overlap: true });
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const first = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  const r1 = first.laneId;
  assert.notEqual(r1, f.lane.laneId);
  // The first conflict is edited free of markers and resolved, then main moves again before it lands.
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const [resolve, parameters] = strip(first.next);
  await s.transport(root).dispatch(resolve, parameters);
  moveMainAgain(f, 'theirs again\nb\nc\n');
  writeFileSync(join(root, 'notes.txt'), 'unsaved notes\n');
  const second = (await s.transport(root).dispatch('sync', {})).result.conflict;
  assert.equal(second.laneId, r1, 'the resolution of the resolution keeps the Lane id');
  assert.equal(second.root, canonicalRoot(root), 'the same folder');
  assert.equal(readHostedLaneCheckout(root).selection.laneId, r1);
  assert.equal(readHostedLaneCheckout(root).selection.head, second.head, 'the folder holds the new draft');
  const marked = readFileSync(join(root, 'a.txt'), 'utf8');
  assert.match(marked, /chosen/);
  assert.match(marked, /theirs again/);
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'unsaved notes\n', 'unsaved edits stay');
  assert.equal(second.next.action, 'resolve', 'the earlier resolve is not replayed as finished');
  assert.notEqual(second.next.operationId, first.next.operationId, 'a new resolve operation');
  assert.equal((await f.readLane(r1)).resolution.origin.laneId, f.lane.laneId);
  // Resolve and land from the same folder: the first Lane completes and no other Lane exists.
  writeFileSync(join(root, 'a.txt'), 'final\nb\nc\n');
  const [again, again2] = strip(second.next);
  const fixed = await s.transport(root).dispatch(again, again2);
  const [finish, selection] = strip(fixed.result.next);
  const submitted = await s.transport(root).dispatch(finish, selection);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'final\nb\nc\n');
  assert.equal((await f.readLane(f.lane.laneId)).state, 'completed', "the chain's first Lane completes");
  const drafted = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request).kind);
  assert.deepEqual(drafted, ['sync', 'resolve', 'sync', 'resolve']);
  const lanes = new Set(
    [...f.tables.projectHostedRecords.values()].filter(row => row.kind === 'lane').map(row => row.key),
  );
  assert.deepEqual([...lanes].sort(), [f.lane.laneId, r1].sort(), 'one resolution Lane for the chain');
});

/** The incident chain up to the second draft in the same folder (b5e8e2d5). */
async function secondDraft(t, { land = false } = {}) {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f,
    root = s.root;
  f.moveMain({ overlap: true });
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const first = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const fixed = await s.transport(root).dispatch(...strip(first.next));
  const landing = land ? await s.transport(root).dispatch(...strip(fixed.result.next)) : undefined;
  moveMainAgain(f, 'theirs again\nb\nc\n');
  const second = (await s.transport(root).dispatch('sync', {})).result.conflict;
  assert.equal(second.laneId, first.laneId);
  return { s, f, root, first, fixed, landing, second };
}

test('b5e8e2d5: replaying the earlier draft resolve never settles or lands the newer draft', async t => {
  const { s, root, first, second } = await secondDraft(t);
  const marked = readFileSync(join(root, 'a.txt'), 'utf8');
  const replay = (await s.transport(root).dispatch(...strip(first.next))).result;
  assert.equal(replay.earlierDraft, true);
  assert.deepEqual(replay.next, second.next, 'the newer draft still needs its own resolve');
  assert.equal(readHostedLaneCheckout(root).selection.head, second.head, 'the folder keeps the newer draft');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), marked);
  await assert.rejects(s.transport(root).dispatch('finish', { message: 'too early' }), {
    code: 'CONFLICT_MARKERS',
  });
  // Resolving the newer draft is unaffected.
  writeFileSync(join(root, 'a.txt'), 'final\nb\nc\n');
  const fixed = await s.transport(root).dispatch(...strip(second.next));
  assert.equal(fixed.result.next.action, 'finish');
});

test('b5e8e2d5: replaying the earlier draft sync never puts that draft back in the folder', async t => {
  const { s, f, root, second } = await secondDraft(t);
  const sync = s.calls.find(call => call.name === 'projectHostedSync:prepare');
  const firstSync = JSON.parse(sync.args.request);
  assert.equal(firstSync.laneId, f.lane.laneId);
  const marked = readFileSync(join(root, 'a.txt'), 'utf8');
  const replay = (
    await s.transport(root).dispatch('sync', { laneId: f.lane.laneId, operationId: sync.args.operationId })
  ).result;
  assert.equal(replay.conflict?.earlierDraft, true, JSON.stringify(replay.conflict ?? replay).slice(0, 400));
  assert.equal(replay.conflict.next.operationId, second.next.operationId, 'the current resolve is named');
  assert.equal(readHostedLaneCheckout(root).selection.head, second.head);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), marked);
});

test('b5e8e2d5 queue: a live landing of the earlier draft is superseded when the Lane takes the new draft', async t => {
  const { s, f, root, landing, second } = await secondDraft(t, { land: true });
  const old = landing.result.submission.id;
  await f.drain();
  const { submission } = await f.current(old);
  assert.notEqual(submission.phase, 'landed');
  assert.equal(submission.observation?.state ?? submission.phase, 'superseded', JSON.stringify(submission));
  writeFileSync(join(root, 'a.txt'), 'final\nb\nc\n');
  const fixed = await s.transport(root).dispatch(...strip(second.next));
  const submitted = await s.transport(root).dispatch(...strip(fixed.result.next));
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'final\nb\nc\n');
});
