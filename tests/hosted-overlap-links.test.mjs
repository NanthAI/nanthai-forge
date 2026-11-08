// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { digest } from '../dist/hash.js';

const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

const PEER = 'user_PEERACCOUNT01';
const shared = 'src/shared.ts';
const changeFor = (path, seed, advisory = false) => [
  {
    path,
    // A base file with no range evidence reads as an advisory 'unavailable' pair; two additions block.
    before: advisory ? { blob: digest(path + 'base'), mode: 'file' } : null,
    after: { blob: digest(path + seed), mode: 'file' },
  },
];

/** The caller's Lane plus peers written through the real Lane record path. */
async function project() {
  const s = await saveFixture('original', 'a.txt');
  const base = JSON.parse(
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
      head: base.head,
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
  /** A Lane with saved changes on the shared path; `extra` adds stack or resolution links. */
  const lane = async (intent, extra = {}, intentId = randomUUID()) => {
    const first = {
      ...base,
      id: randomUUID(),
      intentId,
      actor: PEER,
      version: 0,
      at: new Date().toISOString(),
      ...extra,
    };
    await write(first, { baseSequence: 0, intent });
    const saved = { ...first, head: digest(first.id), version: 1, sourceVersion: 1 };
    await write(saved, { baseSequence: 0, intent, changes: changeFor(shared, first.id) }, 0);
    return saved;
  };
  const read = (laneId, args = {}) =>
    s
      .transaction(
        'projectHostedOverlaps:read',
        overlaps.read,
        { projectId: s.projectId, laneId, ...args },
        'owner',
      )
      .then(JSON.parse);
  const noticed = async laneId =>
    new Set((await read(laneId)).unacknowledgedOverlaps.items.flatMap(item => item.lanes));
  const overlapRow = laneId =>
    [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
  return { s, lane, read, noticed, overlapRow };
}
const resolutionOf = (origin, left = digest('moved')) => ({
  resolution: {
    candidateId: null,
    conflicts: { sha256: digest('conflicts'), size: 1 },
    left,
    right: digest('right'),
    draftHead: digest('draft'),
    origin: { laneId: origin.id, head: origin.head, sourceVersion: 1 },
    status: 'resolved',
  },
});
const stackOn = (parent, head = digest('pin')) => ({ stack: { laneId: parent.id, head } });

// Issue ee9d5738 (friction ee726a66, c9f5a7c0): replay of the B1.5d and wave-5 notices a builder could
// do nothing about. Each assertion fails on the head-matching and per-pair exclusions before this change.

test('a resolve Lane gets no overlap notice about its origin Lane, whatever either head is now', async () => {
  const { lane, noticed, overlapRow } = await project();
  const origin = await lane('Original work');
  const unrelated = await lane('Someone else');
  const resolve = await lane('Resolution', resolutionOf(origin));
  const sibling = await lane('Second resolution of the same origin', resolutionOf(origin, digest('other')));
  assert.equal(overlapRow(resolve.id).resolutionOrigin, origin.id);
  // The resolved `left` no longer equals the origin's head (dcce1822): only the Lane id still ties them.
  assert.notEqual(resolve.resolution.left, origin.head);
  const mine = await noticed(resolve.id);
  assert(!mine.has(origin.id), 'the origin is not a peer to the Lane resolving it');
  assert(!mine.has(sibling.id), 'nor are its other resolutions');
  assert(mine.has(unrelated.id), 'unrelated work still notifies');
  const theirs = await noticed(origin.id);
  assert(
    !theirs.has(resolve.id) && !theirs.has(sibling.id),
    'the origin hears nothing about its resolutions',
  );
  assert(theirs.has(unrelated.id));
});

test('Lanes of one stack get no overlap notices about each other; other Lanes and detached ones do', async () => {
  const { lane, noticed, overlapRow } = await project();
  const root = await lane('Stack root');
  const child = await lane('On the root', stackOn(root));
  const grandchild = await lane('On the child', stackOn(child));
  const sibling = await lane('Also on the root', stackOn(root));
  const outsider = await lane('Not in the stack');
  const detached = await lane('Left the stack', { stack: { ...stackOn(root).stack, detached: true } });
  assert.equal(overlapRow(child.id).stackRoot, root.id);
  assert.equal(overlapRow(grandchild.id).stackRoot, root.id, 'the root, not the parent');
  assert.equal(overlapRow(root.id).stackRoot, undefined);
  assert.equal(overlapRow(outsider.id).stackRoot, undefined, 'a Lane outside any stack stores nothing');
  assert.equal(overlapRow(detached.id).stackRoot, undefined);
  const stack = [root, child, grandchild, sibling];
  for (const member of stack) {
    const seen = await noticed(member.id);
    for (const other of stack)
      if (other !== member) assert(!seen.has(other.id), `${member.id} / ${other.id}`);
    assert(seen.has(outsider.id) && seen.has(detached.id), 'peers outside the stack still notify');
  }
  const outside = await noticed(outsider.id);
  for (const member of stack) assert(outside.has(member.id), 'the outsider hears about the stack');
});

test('a stack member whose row predates the link fields still excludes its stack, from the Lane record', async () => {
  const { lane, noticed, overlapRow, s } = await project();
  const root = await lane('Stack root');
  const child = await lane('On the root', stackOn(root));
  const outsider = await lane('Not in the stack');
  // Rows written before this field existed carry neither link; the focus Lane's own record supplies them.
  s.patch('projectHostedOverlapLanes', overlapRow(child.id)._id, {
    stackRoot: undefined,
    stackParent: undefined,
  });
  const seen = await noticed(child.id);
  assert(!seen.has(root.id), 'parent excluded from the record alone');
  assert(seen.has(outsider.id));
});
