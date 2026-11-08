// SPDX-License-Identifier: Apache-2.0
// Frictions 5b1c7e0e, d184519f, f32613f2: a mid-work sync conflict moved the builder's work to
// another (sometimes nested) folder. The resolution now happens in the builder's own folder,
// keeps unsaved edits, and any other Lane folder is a sibling, never nested. Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { laneSiblingPath } from '../dist/hosted-root-checkout.js';
import { canonicalRoot } from '../dist/root-paths.js';

const strip = ({ action, ...parameters }) => [action, parameters];

test('mid-work sync conflict resolves in the same folder, keeps unsaved edits, then lands', async t => {
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
  assert.match(readFileSync(join(root, 'a.txt'), 'utf8'), /<<<<<<< lane/);
  assert.deepEqual(conflict.kept.paths, ['a.txt']);
  assert.equal(
    readFileSync(join(conflict.kept.at, 'a.txt'), 'utf8'),
    'mine\nb\nc\n',
    'overlapping edit kept',
  );
  assert(!conflict.kept.at.startsWith(`${canonicalRoot(root)}/`), 'kept outside the source tree');
  assert.match(conflict.workIn, /\(same folder\).*a\.txt also changed on main; they are copied to /);
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
  assert.equal(f.text(f.currentMain().head, 'notes.txt'), 'unsaved notes\n', 'the carried edit landed');
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
