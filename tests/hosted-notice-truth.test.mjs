// SPDX-License-Identifier: Apache-2.0
// Item 3f70760d: overlap and conflict notices stay true. Builders act on every EXACT CONFLICT,
// protected-path and "Sync now" line; a stale one sends them to sync, wait or ask for nothing
// (frictions 9ad0df2e, e58dee09, c0584a78, 5c2b5e1b, 72c4e921, 8366f56e, 700035fd, d26e7f62).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { trialMerge } from '../dist/hosted-trial-merge.js';
import { bindTrialSides } from '../dist/hosted-trial-plan.js';
import { exactConflictNotice } from '../dist/hosted-conflict-notice.js';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-overlaps-fixture.mjs';

const superseded = await import(moduleUrl('../convex/projectHostedSuperseded.ts'));
const pendingOverlap = await import(moduleUrl('../convex/projectHostedSavePendingOverlap.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const exact = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
// A fixed fixture instant for the stamps these tests write; no code under test compares it to the clock.
const AT = '2026-11-20T12:00:00.000Z';

const overlapRow = (s, laneId) =>
  [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
const openNotices = s => [...s.tables.projectHostedConflictNotices.values()].filter(row => row.open);
/** Every surface a builder reads a conflict from: the save reply, status and peers. */
async function surfaces(transport, laneId, saved) {
  return {
    save: saved?.conflictNotice,
    status: (await transport.dispatch('status', { laneId })).conflictNotice,
    peers: (await transport.dispatch('peers', { laneId })).conflictNotice,
  };
}
const none = { save: undefined, status: undefined, peers: undefined };

for (const settling of [false, true])
  test(`9ad0df2e/e58dee09: a ${settling ? 'background' : 'direct'} save restoring the file to its pinned base clears the conflict on that save`, async t => {
    let defer = false,
      deferred;
    const { s, lane, peer, transport } = await setup(t, {
      // Only the restoring save settles in the background: it replies before its head publishes.
      background: () => defer,
      deferPublish: async publish => {
        if (defer) deferred = publish;
        return defer;
      },
    });
    const first = transport(lane),
      second = transport(peer);
    await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
    const conflicted = await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
    assert.equal(conflicted.conflictNotice.items[0].with, lane.id, 'a live conflict shows');
    // Restored byte for byte to the Lane's pinned base: the Lane no longer changes the file.
    writeFileSync(join(second.root, 'a.txt'), 'original');
    defer = settling;
    const restored = await second.dispatch('save', { operationId: randomUUID(), message: 'restore' });
    if (settling) assert.equal(restored.result.status, 'settling');
    // A settling save replies before its head publishes: it names no notice of the head it replaces.
    assert.deepEqual({ ...(await surfaces(second, peer.id, restored)) }, none);
    if (settling) await deferred();
    assert.deepEqual(await surfaces(second, peer.id), none, 'published: still none');
    assert.equal((await first.dispatch('peers', { laneId: lane.id })).conflictNotice, undefined);
    assert.deepEqual(openNotices(s), [], 'both sides of the pair ended in that save');
  });

for (const [name, mark] of [
  ['landed at its head (its own landing, or through its resolution)', row => ({ landed: stamp(row) })],
  [
    'superseded at its head by a landing of its Intent',
    row => ({ superseded: { ...stamp(row), by: randomUUID() } }),
  ],
])
  test(`c0584a78/5c2b5e1b: no surface names a peer Lane ${name}`, async t => {
    const { s, lane, peer, transport } = await setup(t);
    const first = transport(lane),
      second = transport(peer);
    await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
    await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
    assert.equal((await second.dispatch('peers', { laneId: peer.id })).conflictNotice.items[0].with, lane.id);
    const row = overlapRow(s, lane.id);
    Object.assign(row, mark(row));
    assert.deepEqual(await surfaces(second, peer.id), none);
    // A revert takes the landing off main: its work is live again.
    if (row.landed) {
      row.landed.revertedBy = { receiptId: randomUUID(), at: AT };
      assert.equal(
        (await second.dispatch('peers', { laneId: peer.id })).conflictNotice.items[0].with,
        lane.id,
      );
    }
  });

const stamp = row => ({
  receiptId: randomUUID(),
  commit: 'c'.repeat(64),
  laneHead: row.head,
  at: AT,
});

test('c0584a78: superseding a Lane ends its exact conflicts on both sides and clears both flags', async t => {
  const { s, lane, peer, transport } = await setup(t);
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'first' });
  await transport(peer).dispatch('save', { operationId: randomUUID(), message: 'second' });
  assert.equal(openNotices(s).length, 2, 'one notice per side');
  const marked = await s.transaction(
    'supersede',
    {
      _handler: ctx =>
        superseded.supersedeLane(ctx, {
          projectId: s.projectId,
          laneId: lane.id,
          by: randomUUID(),
          receiptId: randomUUID(),
          at: AT,
        }),
    },
    {},
  );
  assert.equal(marked, true);
  assert.deepEqual(openNotices(s), []);
  assert.equal(overlapRow(s, lane.id).conflicted, undefined);
  assert.equal(overlapRow(s, peer.id).conflicted, undefined);
});

test('c0584a78: a plain status in the Lane tells a superseded Lane from a live one, from the overlap read', async t => {
  const { s, lane, transport } = await setup(t);
  const first = transport(lane);
  await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  const status = async () => (await first.dispatch('status', {})).superseded;
  assert.equal(await status(), undefined, 'a live Lane names no successor');
  const row = overlapRow(s, lane.id),
    by = randomUUID();
  row.superseded = { ...stamp(row), by };
  const marked = await status();
  assert.equal(marked.by, by);
  assert.equal(marked.receiptId, row.superseded.receiptId);
  assert(marked.summary.startsWith(`superseded by Lane ${by} (receipt ${row.superseded.receiptId})`));
  row.superseded = { ...row.superseded, laneHead: 'older-head' };
  assert.equal(await status(), undefined, 'saved past the superseded head: live again');
});

/** Runs the newest scheduled trial for a Lane head, as the fixture's publish does. */
async function runTrial(s, head, since = 0) {
  const task = s.scheduled
    .slice(since)
    .findLast(
      task => task.name === 'projectHostedConflictMerge:run' && JSON.parse(task.args.plan).head === head,
    );
  assert(task, 'a trial was planned');
  const plan = JSON.parse(task.args.plan);
  const result = await trialMerge(plan.tasks, id => s.objects.get(id));
  await s.transaction('trial', exact.record, {
    projectId: s.projectId,
    laneId: plan.laneId,
    head: plan.head,
    peers: plan.peers,
    ...(plan.main ? { mainHead: plan.main.head } : {}),
    conflicts: result.conflicts,
  });
}

test('3f70760d review: a background save that restored the file and then failed brings the real conflict back', async t => {
  let defer = false;
  const { s, lane, peer, transport } = await setup(t, {
    background: () => defer,
    deferPublish: async () => defer,
  });
  const first = transport(lane),
    second = transport(peer);
  await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
  const savedHead = overlapRow(s, peer.id).head;
  writeFileSync(join(second.root, 'a.txt'), 'original');
  defer = true;
  await second.dispatch('save', { operationId: randomUUID(), message: 'restore' });
  assert.deepEqual(openNotices(s), [], 'the pending restore ended the pair');
  // The worker fails: nothing of the restore was saved, so the saved head still conflicts.
  const row = [...s.tables.projectHostedSaves.values()].findLast(
    row => row.laneId === peer.id && row.background,
  );
  const planned = s.scheduled.length;
  // Through the save fixture's call, whose scheduler records the trial it plans.
  await s.call(
    'fail',
    { _handler: ctx => pendingOverlap.revertPendingSaveOverlap(ctx, row, JSON.parse(row.value)) },
    {},
  );
  assert.deepEqual(
    JSON.parse(overlapRow(s, peer.id).changes).map(change => change.path),
    ['a.txt'],
    'the saved change is evidence again',
  );
  assert.equal(overlapRow(s, peer.id).settled, undefined, 'no save is settling any more');
  await runTrial(s, savedHead, planned);
  assert.equal((await second.dispatch('peers', { laneId: peer.id })).conflictNotice.items[0].with, lane.id);
});

test('3f70760d review: a failed pending save takes out only its own paths; a head move starts from the saved evidence', async t => {
  const { s, lane, transport } = await setup(t);
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'first' });
  const change = (path, after) => ({
    path,
    before: null,
    after: { blob: digest(Buffer.from(after)), mode: 'file' },
  });
  const write = metadata =>
    s.transaction(
      'track',
      {
        _handler: async ctx => {
          const head = await records.recordHead(ctx, s.projectId, 'lane', lane.id);
          const record = JSON.parse(await records.hostedRecordBody(ctx, await ctx.db.get(head.recordId)));
          await tracking.trackHostedOverlapLane(
            ctx,
            s.projectId,
            metadata.head ? { ...record, head: metadata.head } : record,
            metadata,
          );
        },
      },
      {},
    );
  const paths = () => JSON.parse(overlapRow(s, lane.id).changes).map(change => change.path);
  const saved = paths();
  const one = [change('one.txt', 'one')],
    two = [change('two.txt', 'two'), change('a.txt', 'two')];
  await write({ changes: one, complete: true, pending: true });
  await write({ changes: two, complete: true, pending: true });
  assert.deepEqual(paths(), [...new Set([...saved, 'one.txt', 'two.txt'])].sort());
  // The first fails while the second still settles: only one.txt leaves; a.txt keeps the second's bytes.
  await write({ restorePending: [{ changes: two, complete: true }] });
  assert.deepEqual(paths(), [...new Set([...saved, 'two.txt'])].sort());
  const a = JSON.parse(overlapRow(s, lane.id).changes).find(change => change.path === 'a.txt');
  assert.equal(a.after.blob, two[1].after.blob);
  assert.deepEqual(overlapRow(s, lane.id).settled.paths.sort(), ['a.txt', 'one.txt', 'two.txt']);
  // Another pending save, then the second publishes a new head: the pending third never reaches it.
  await write({ changes: [change('three.txt', 'three')], complete: true, pending: true });
  await write({ head: 'ab'.repeat(32), changes: two, complete: true });
  assert.deepEqual(paths(), [...new Set([...saved, 'two.txt'])].sort());
  assert.equal(overlapRow(s, lane.id).settled, undefined);
});

test('3f70760d review: a trial recorded after a side landed or was superseded opens no notice', async t => {
  const { s, lane, peer, transport } = await setup(t);
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'first' });
  await transport(peer).dispatch('save', { operationId: randomUUID(), message: 'second' });
  const conflicts = openNotices(s).flatMap(row => row.paths.map(file => ({ peer: row.peer, ...file })));
  await superseded_(s, lane.id);
  assert.deepEqual(openNotices(s), []);
  // The trial planned before the supersede comes back late with the same conflict.
  const me = overlapRow(s, peer.id),
    them = overlapRow(s, lane.id);
  await s.transaction('trial', exact.record, {
    projectId: s.projectId,
    laneId: peer.id,
    head: me.head,
    peers: [{ laneId: lane.id, head: them.head }],
    conflicts: conflicts
      .filter(item => item.peer === lane.id)
      .map(({ path, mine, theirs, reason }) => ({ peer: lane.id, path, mine, theirs, reason })),
  });
  assert.deepEqual(openNotices(s), [], 'the late trial names no superseded Lane');
});

const superseded_ = (s, laneId) =>
  s.transaction(
    'supersede',
    {
      _handler: ctx =>
        superseded.supersedeLane(ctx, {
          projectId: s.projectId,
          laneId,
          by: randomUUID(),
          receiptId: randomUUID(),
          at: AT,
        }),
    },
    {},
  );

// Trial merges (pure): identical lines, a kept-open Lane's own landing, and main only where main changed.
const blobs = new Map();
const file = text => {
  if (text === null) return null;
  const bytes = Buffer.from(text),
    blob = digest(bytes);
  blobs.set(blob, bytes);
  return { blob, mode: 'file' };
};
const merge = tasks => trialMerge(tasks, blob => blobs.get(blob)).then(result => result.conflicts);
const base = 'a\nb\nc\nd\ne\nf\n',
  moved = 'A\nb\nc\nd\ne\nf\n',
  added = text => text.replace('c\n', 'c\nN1\nN2\n');

test('72c4e921: two Lanes that added identical lines are no exact conflict, on any base', async () => {
  const pair = (mine, peer, main) => [
    {
      path: 'x.mjs',
      mine: { before: file(mine[0]), after: file(mine[1]) },
      ...(main === undefined ? {} : { main: file(main) }),
      peers: [{ laneId: 'peer', before: file(peer[0]), after: file(peer[1]) }],
    },
  ];
  for (const [name, tasks] of [
    ['same base', pair([base, added(base)], [base, added(base)])],
    ['appended at the end', pair([base, base + 'T\n'], [base, base + 'T\n'])],
    ['the same new file', pair([null, 'x\ny\n'], [null, 'x\ny\n'])],
    ['the peer on a newer main', pair([base, added(base)], [moved, added(moved)], moved)],
    ['this Lane on a newer main', pair([moved, added(moved)], [base, added(base)])],
  ])
    assert.deepEqual(await merge(tasks), [], name);
  // A real difference on the same lines still conflicts.
  assert.equal(
    (await merge(pair([base, base.replace('c\n', 'C1\n')], [base, base.replace('c\n', 'C2\n')]))).length,
    1,
  );
});

const states = entries => new Map(Object.entries(entries).map(([path, text]) => [path, file(text)]));

test("8366f56e: a kept-open Lane's own accepted lines are never a conflict with main", async () => {
  // Landed head 1 (a modified file and an added one), kept open, then edited both again.
  const landed = { 'x.mjs': added(base), 'new.mjs': 'x\ny\n' },
    saved = {
      'x.mjs': added(base).replace('N2\n', 'N2\nN3\n').replace('f\n', 'MINE\n'),
      'new.mjs': 'x\ny\nz\n',
    };
  const plan = laneLanded => ({
    laneId: 'lane',
    tasks: Object.keys(saved).map(path => ({
      path,
      mine: { before: null, after: null },
      peers: [],
    })),
    main: { head: 'm', state: {}, paths: Object.keys(saved) },
    sources: [
      {
        laneId: 'lane',
        base: states({ 'x.mjs': base }),
        head: states(saved),
        ...(laneLanded ? { landed: states(landed) } : {}),
      },
    ],
  });
  const conflicts = async laneLanded => {
    const selected = plan(laneLanded);
    bindTrialSides(selected, selected.sources, states(landed));
    return merge(selected.tasks);
  };
  // Measured from the old base, main's copy of the Lane's own landing reads as the other side.
  assert.equal((await conflicts(false)).length, 2, 'the incident: both files flagged against main');
  assert.deepEqual(await conflicts(true), [], 'measured from its landed head: nothing to sync');
  // The same Lane as a peer of a Lane started from main after its landing (review finding).
  const after = { ...landed, 'x.mjs': added(base).replace('N1\n', 'OTHER\n') };
  const peerPlan = {
    laneId: 'other',
    tasks: [
      {
        path: 'x.mjs',
        mine: { before: null, after: null },
        peers: [{ laneId: 'lane', before: null, after: null }],
      },
    ],
    sources: [
      { laneId: 'other', base: states(landed), head: states(after) },
      {
        laneId: 'lane',
        base: states({ 'x.mjs': base }),
        head: states({ ...landed, 'y.mjs': 'y\n' }),
        landed: states(landed),
      },
    ],
  };
  bindTrialSides(peerPlan, peerPlan.sources);
  assert.deepEqual(await merge(peerPlan.tasks), [], "a peer's accepted lines are not its pending edit");
  // Main moved on after the landing: a real later edit of the same lines still conflicts.
  const later = plan(true);
  bindTrialSides(later, later.sources, states({ ...landed, 'x.mjs': added(base).replace('f\n', 'MAIN\n') }));
  assert.deepEqual(
    (await merge(later.tasks)).map(conflict => [conflict.peer, conflict.path]),
    [['main', 'x.mjs']],
  );
});

test("700035fd: 'Sync now; your saved files conflict with main' appears only when a main commit touched the file", async () => {
  // A peer-only shared file: main never changed it after the Lane's base, but the Lane's saved
  // delta describes a sync draft whose before is not main's file.
  const draft = 'draft\nb\nc\n',
    onMain = 'a\nb\nc\n';
  const plan = paths => ({
    laneId: 'lane',
    tasks: [
      {
        path: 'x.mjs',
        mine: { before: file(draft), after: file('a\nMINE\nc\n') },
        peers: [{ laneId: 'peer', before: file(onMain), after: file('a\nPEER\nc\n') }],
      },
    ],
    main: { head: 'm', state: {}, paths },
  });
  const untouched = plan([]);
  bindTrialSides(untouched, [], states({ 'x.mjs': onMain }));
  const found = await merge(untouched.tasks);
  assert.deepEqual(
    found.map(conflict => conflict.peer),
    ['peer'],
  );
  const notice = exactConflictNotice('lane', [
    {
      with: 'peer',
      goal: 'Peer change',
      flaggedAt: AT,
      files: found.map(({ path, mine, theirs, reason }) => ({ path, mine, theirs, reason })),
    },
  ]);
  assert.doesNotMatch(notice.next, /conflict with main/);
  assert.match(notice.next, /conflict with Lane peer/);
  // Main did change the file after the Lane's base: main is named.
  const touched = plan(['x.mjs']);
  bindTrialSides(touched, [], states({ 'x.mjs': 'a\nMAIN\nc\n' }));
  assert((await merge(touched.tasks)).some(conflict => conflict.peer === 'main'));
});
