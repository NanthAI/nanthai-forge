// SPDX-License-Identifier: Apache-2.0
// Frictions 5b1c7e0e, d184519f, f32613f2: a mid-work sync conflict moved the builder's work to
// another (sometimes nested) folder. The resolution now happens in the builder's own folder,
// keeps unsaved edits, and any other Lane folder is a sibling, never nested. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { laneSiblingPath } from '../dist/hosted-root-checkout.js';
import { canonicalRoot } from '../dist/root-paths.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { ForgeError } from '../dist/errors.js';
import { getFunctionName } from 'convex/server';
import { keptCopies, resolutionFolderReason, workInLine } from '../dist/hosted-resolution-placement.js';
import { laneChangeBase } from '../dist/hosted-conflict-precheck.js';

const strip = ({ action, ...parameters }) => [action, parameters];

test('mid-work sync conflict saves the edits first, resolves in the same folder, then lands', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  // Unsaved work: a new file the resolution does not touch, and an edit to the conflicting file.
  writeFileSync(join(root, 'notes.txt'), 'unsaved notes\n');
  writeFileSync(join(root, 'a.txt'), 'mine\nb\nc\n');
  const before = s.calls.length;
  const synced = await s.transport(root).dispatch('sync', { laneId: f.lane.laneId });
  // 48835eea: save --sync saves first, so both edits are in the Lane head before the merge meets main.
  assert.equal(synced.result.saved?.status, 'completed', JSON.stringify(synced.result.saved));
  const conflict = synced.result.conflict;
  assert.equal(conflict.root, canonicalRoot(root), 'the same folder');
  // One read of the resolution Lane: the in-place rebase reuses the access recheck's selection.
  const selects = s.calls
    .slice(before)
    .filter(call => call.name === 'projectHostedLanes:select' && call.args.laneId === conflict.laneId);
  assert.equal(selects.length, 1);
  assert.equal(
    readHostedLaneCheckout(root).selection.laneId,
    conflict.laneId,
    'the folder is the resolution',
  );
  assert.equal((await f.readLane(conflict.laneId)).resolution.origin.laneId, f.lane.laneId);
  assert(!existsSync(`${canonicalRoot(root)}.forge-client/lanes/${conflict.laneId}`), 'nothing nested');
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'unsaved notes\n', 'untouched edit stays');
  const marked = readFileSync(join(root, 'a.txt'), 'utf8');
  assert.match(marked, /<<<<<<< lane/);
  assert.match(marked, /mine/, 'the saved edit is the Lane side of the conflict');
  assert.equal(conflict.kept, undefined, 'nothing set aside: the edits were saved first');
  // ad80e037: the stop says what was saved (the merged Lane head) and the next step.
  const savedHead = (await f.readLane(conflict.laneId)).resolution.origin.head;
  assert.match(conflict.workIn, new RegExp(`Saved: the Lane's saved head ${savedHead.slice(0, 12)} `));
  assert.doesNotMatch(conflict.workIn, /NOT saved/);
  // Resolve and land from the same folder; the original Lane completes with it.
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const [resolve, parameters] = strip(conflict.next);
  const fixed = await s.transport(root).dispatch(resolve, parameters);
  const [finish, selection] = strip(fixed.result.next);
  const submitted = await s.transport(root).dispatch(finish, selection);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
  assert.equal(f.text(f.currentMain().head, 'notes.txt'), 'unsaved notes\n', 'the saved edit landed');
  assert.equal((await f.readLane(f.lane.laneId)).state, 'completed');
  // The handoff's original Lane id, used from this folder, reports the settled resolution.
  const replay = await s.transport(root).dispatch('finish', { laneId: f.lane.laneId });
  assert.equal(replay.result.recovery.conflict.state, 'completed');
  assert.equal(replay.result.submission, undefined, 'never a second landing of the original head');
  const prepares = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request).kind);
  assert.deepEqual(prepares, ['sync', 'resolve'], 'one resolution draft, never a second');
});

test('593fc2d7: a sync conflict records the merged head, so the resolution Lane preflights against it', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  const selection = readHostedLaneCheckout(root).selection;
  const { resolution } = await f.readLane(conflict.laneId);
  assert.notEqual(
    selection.base.head,
    resolution.right,
    "the resolution Lane keeps the conflicted Lane's base",
  );
  assert.equal(laneChangeBase(root, selection), resolution.right);
});

// An edit written while the sync runs (after its save-first) meets the merge unsaved: it is set aside.
function editDuringSync(t, s, edit) {
  const mutation = s.exchange.client.mutation;
  let done = false;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (!done && getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
      done = true;
      edit();
    }
    return result;
  };
  t.after(() => (s.exchange.client.mutation = mutation));
}

test('ad80e037: a sync rerun from a folder that is already the resolution Lane still names the set-aside copies', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  editDuringSync(t, s, () => writeFileSync(join(root, 'a.txt'), 'mine\nb\nc\n'));
  const first = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  assert.deepEqual(first.kept.paths, ['a.txt']);
  // The rerun takes the already-the-resolution branch (as after a crash before the first reply).
  const again = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  assert.deepEqual(again.kept, first.kept);
  assert.match(again.workIn, /NOT saved: unsaved edits to a\.txt also changed on main; copies are in /);
  assert.match(again.instruction, /^Unsaved edits to a\.txt were not saved; copies are in /);
  // The list comes from the folder itself, so a run that died after setting copies aside still names them.
  assert.deepEqual(
    keptCopies(root, again.laneId ?? readHostedLaneCheckout(root).selection.laneId),
    again.kept,
  );
});

test('ad80e037: an unsaved deletion of a file the merge changed is reported as restored, never as left in place', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  editDuringSync(t, s, () => rmSync(join(root, 'a.txt')));
  const synced = await s.transport(root).dispatch('sync', { laneId: f.lane.laneId });
  const conflict = synced.result.conflict;
  assert.deepEqual(conflict.restored, ['a.txt']);
  assert(existsSync(join(root, 'a.txt')), 'the merge put the file back');
  assert.match(conflict.workIn, /Restored: the unsaved deletion of a\.txt was undone/);
  assert.equal(conflict.kept, undefined, 'nothing to set aside: the file was deleted');
});

test('ad80e037: a new resolution folder names which side moved and says what is saved and what stays behind', () => {
  const lane = 'a1b2c3d4';
  // The folder is behind the Lane's save: never the backwards "saved again" reason.
  const behind = resolutionFolderReason(
    { laneId: lane, sourceVersion: 3 },
    { laneId: lane, sourceVersion: 4 },
    false,
  );
  assert.match(behind, /^the Lane has a newer save \(source version 4\) than this folder holds \(3\)/);
  assert.doesNotMatch(behind, /saved again/);
  assert.match(
    resolutionFolderReason({ laneId: lane, sourceVersion: 5 }, { laneId: lane, sourceVersion: 4 }, false),
    /^this folder was saved again after the conflict/,
  );
  assert.equal(
    resolutionFolderReason(undefined, { laneId: lane, sourceVersion: 4 }, false),
    'this folder is not a Lane checkout',
  );
  assert.equal(
    resolutionFolderReason({ laneId: lane, sourceVersion: 4 }, { laneId: lane, sourceVersion: 4 }, true),
    'this folder holds another unresolved draft',
  );
  assert.equal(
    resolutionFolderReason({ laneId: 'other', sourceVersion: 1 }, { laneId: lane, sourceVersion: 4 }, false),
    'this folder holds another Lane',
  );
  const head = 'f'.repeat(64);
  const line = workInLine('/new', 'res', false, undefined, behind, head, undefined, '/old');
  assert.match(line, /^WORK IN \/new \(new folder for resolution Lane res\): the Lane has a newer save/);
  assert.match(
    line,
    new RegExp(`Saved: the new folder holds the Lane's saved head ${head.slice(0, 12)} merged with main\\.`),
  );
  assert.match(
    line,
    /NOT carried: \/old is unchanged and its unsaved edits stay there; copy any the resolution needs into the new folder\./,
  );
});

test('a new land naming the origin Lane after an edited, unresolved in-place resolution refuses before composing (41fc0c29)', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  assert.equal(readHostedLaneCheckout(root).selection.laneId, conflict.laneId);
  const before = s.calls.length;
  // Markers edited away but resolve not run: landing the origin's old head would compose the same
  // conflict again after a queue wait; the refusal names the one resolve command instead.
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  await assert.rejects(s.transport(root).dispatch('finish', { laneId: f.lane.laneId }), error => {
    assert.equal(error.code, 'RESOLUTION_REQUIRED');
    assert.equal(error.recovery.next.action, 'resolve');
    assert.equal(error.recovery.next.laneId, conflict.laneId);
    return true;
  });
  assert.deepEqual(
    s.calls.slice(before).map(call => call.name),
    ['projectHostedAgent:capabilities'],
    'the session read only: no save, compose, check or queue entry',
  );
  // Following the refusal lands the resolution, and the origin completes with it.
  const [resolve, parameters] = strip(conflict.next);
  const fixed = await s.transport(root).dispatch(resolve, parameters);
  const [finish, selection] = strip(fixed.result.next);
  const submitted = await s.transport(root).dispatch(finish, selection);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
  assert.equal((await f.readLane(f.lane.laneId)).state, 'completed');
});

test('land --save after editing the conflict files saves the resolution and lands it (41fc0c29)', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  // What the agent's prompt says: resolve the markers, run land --save again (naming the Lane it
  // started with). One resolve, then the resolution Lane's landing; never the origin's old head.
  const command = {
    laneId: f.lane.laneId,
    message: 'fix: keep both',
    notVerified: ['Windows tests were not run'],
  };
  const notes = [];
  const write = process.stderr.write;
  process.stderr.write = line => (notes.push(String(line)), true);
  let submitted;
  try {
    submitted = await submitHostedLand(root, command, s.address, s.transport(root));
  } finally {
    process.stderr.write = write;
  }
  assert.match(
    notes.join(''),
    /saved your edited conflict files as the resolution of Lane .*Undo: land --withdraw/,
  );
  assert.equal(submitted.result.submission.request.message ?? 'fix: keep both', 'fix: keep both');
  assert.deepEqual(submitted.result.submission.request.notVerified, command.notVerified);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
  assert.equal((await f.readLane(f.lane.laneId)).state, 'completed');
  assert.equal((await f.readLane(conflict.laneId)).state, 'completed');
  const prepares = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request).kind);
  assert.deepEqual(prepares, ['sync', 'resolve'], 'one resolution draft, never a second');
  // Running the same land again reaches the same landing, never a second one.
  const again = await submitHostedLand(root, command, s.address, s.transport(root));
  assert.notEqual(again.result.submission?.phase, 'queued');
  assert.deepEqual(again.result.submission?.request.notVerified, command.notVerified);
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
});

test('land --save can report a claim on an already saved resolution before its landing starts', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const { conflict } = (await s.transport().dispatch('sync', { laneId: f.lane.laneId })).result;
  writeFileSync(join(s.root, 'a.txt'), 'chosen\nb\nc\n');
  const [action, params] = strip(conflict.next);
  const resolved = await s.transport().dispatch(action, params);
  assert.equal(resolved.result.next.action, 'finish');
  const command = { laneId: f.lane.laneId, notVerified: [] };
  const submitted = await submitHostedLand(s.root, command, s.address, s.transport());
  assert.equal(submitted.operationId, resolved.result.next.operationId);
  assert.deepEqual(submitted.result.submission.request.notVerified, []);
  await assert.rejects(
    submitHostedLand(s.root, { ...command, notVerified: ['A different claim'] }, s.address, s.transport()),
    { code: 'WORK_OPERATION_CHANGED' },
  );
});

test('593fc2d7: land --save on an edited resolution prints the landing operation id first, not the resolve id', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport(root).dispatch('sync', { laneId: f.lane.laneId })).result.conflict;
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const notes = [];
  const write = process.stderr.write;
  process.stderr.write = line => (notes.push(String(line)), true);
  let submitted;
  try {
    submitted = await submitHostedLand(
      root,
      { laneId: f.lane.laneId, message: 'fix', notVerified: [] },
      s.address,
      s.transport(root),
    );
  } finally {
    process.stderr.write = write;
  }
  // A script that takes the first printed id must get the one to wait on.
  const text = notes.join('');
  assert.deepEqual(submitted.result.submission.request.notVerified, []);
  const lanes = [f.lane.laneId, conflict.laneId];
  const ids = (text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).filter(
    id => !lanes.includes(id),
  );
  assert.equal(ids[0], submitted.operationId, text);
  assert.equal(/operationId ([0-9a-f-]{36})/.exec(text)?.[1], submitted.operationId);
  assert.match(notes.join(''), /saved your edited conflict files as the resolution/);
});

test('593fc2d7: save --sync that merges main leaves the folder equal to the saved head (preflight needs no second save)', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(root, 'notes.txt'), 'unsaved notes\n');
  f.moveMain();
  const synced = await s.transport(root).dispatch('sync', { laneId: f.lane.laneId, message: 'wip' });
  assert.equal(synced.result.source.outcome.result.status, 'merged');
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'unsaved notes\n');
  assert.equal(readFileSync(join(root, 'accepted.txt'), 'utf8'), 'already accepted\n');
  assert.equal(synced.result.saved.status, 'completed', 'the sync saved the edits it kept');
  assert.equal(hostedLaneDirty(root, { refresh: true }), false, 'the merge is the saved head');
  const lane = await f.readLane(f.lane.laneId);
  assert.equal(readHostedLaneCheckout(root).selection.head, lane.head);
  // A clean folder makes no save: a second sync answers up to date without one.
  const again = await s.transport(root).dispatch('sync', { laneId: f.lane.laneId });
  assert.equal(again.result.saved, undefined);
});

test('48835eea: a refused save before a sync leaves main uninstalled, the edit in place, and says the sync did not run', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  const root = s.root;
  await s.transport(root).dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(root, 'notes.txt'), 'unsaved notes\n');
  f.moveMain();
  const mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaves:prepare')
      throw new ForgeError('WORK_STALE', 'Synthetic save refusal.');
    return mutation(ref, args);
  };
  t.after(() => (s.exchange.client.mutation = mutation));
  await assert.rejects(s.transport(root).dispatch('sync', { laneId: f.lane.laneId }), error => {
    assert.match(error.message, /^The sync did not run: /);
    return true;
  });
  assert(!existsSync(join(root, 'accepted.txt')), 'main not installed: the sync did not run');
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'unsaved notes\n', 'edit kept');
  assert.equal(hostedLaneDirty(root, { refresh: true }), true, 'still unsaved, and nothing claims otherwise');
});

test('a Lane opened from another Lane folder is its sibling under lanes/, never nested', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const lane = join(dirname(s.root), 'clone.forge-client', 'lanes', f.lane.laneId);
  await s.transport(lane).dispatch('open', { laneId: f.lane.laneId });
  await s.transport(lane).dispatch('save', { laneId: f.lane.laneId, message: 'Work so far' });
  // apply:false leaves this folder alone and names the resolution's open step.
  const synced = await s.transport(lane).dispatch('sync', { laneId: f.lane.laneId, apply: false });
  const [open, parameters] = strip(synced.result.conflict.next);
  const opened = await s.transport(lane).dispatch(open, parameters);
  const lanes = dirname(canonicalRoot(lane));
  assert.equal(opened.result.root, join(lanes, parameters.laneId));
  assert(!existsSync(`${canonicalRoot(lane)}.forge-client/lanes/${parameters.laneId}`));
  assert.equal(
    readHostedLaneCheckout(lane).selection.laneId,
    f.lane.laneId,
    'the original folder is unchanged',
  );
});

test('sibling placement: the clone lanes dir, else a visible sibling of a standalone Lane folder', () => {
  const id = '0123abcd-0000-4000-8000-000000000000';
  assert.equal(laneSiblingPath('/w/clone.forge-client/lanes/other', id), `/w/clone.forge-client/lanes/${id}`);
  assert.equal(laneSiblingPath('/w/my-lane', id), '/w/my-lane-0123abcd');
});
