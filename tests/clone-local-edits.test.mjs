// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject, cloneFreshness } from '../dist/hosted-pull.js';
import {
  cloneLocalEdits,
  carryCloneEdits,
  noteCloneEdits,
  startEditsNotice,
  cloneEditsHeadsUp,
} from '../dist/clone-local-edits.js';
import { readLaneEntry, recordLane } from '../dist/lane-registry.js';
import { randomUUID } from 'node:crypto';

/** The 2026-11-23 shape: edits and a stray file in the shared clone, none of them saved anywhere. */
function stray(f) {
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'edited 0\n');
  fs.rmSync(join(f.root, 'src/1.txt'));
  fs.writeFileSync(join(f.root, 'scratch-notes.md'), 'stray\n');
  fs.mkdirSync(join(f.root, 'newdir'));
  fs.writeFileSync(join(f.root, 'newdir/a.txt'), 'new\n');
}
const kinds = edits => Object.fromEntries(edits.changes.map(c => [c.path, c.kind]));
/** A Lane folder holding the baseline files the clone started from. */
function laneFor(f) {
  const lane = join(f.directory, 'lane');
  fs.mkdirSync(join(lane, 'src'), { recursive: true });
  for (const file of f.state().files) fs.writeFileSync(join(lane, file.path), f.objects.get(file.blob));
  return { lane, files: f.state().files.map(({ path, blob }) => ({ path, blob })) };
}

test('a clean clone has no edits; status lists every edit and untracked path', async t => {
  const f = pullFixture(t);
  assert.equal(cloneLocalEdits(f.root).count, 0);
  const clean = await cloneFreshness(f.root, f.transport);
  assert.equal('edits' in clean, false);
  stray(f);
  const status = await cloneFreshness(f.root, f.transport);
  assert.equal(status.edits.count, 4);
  assert.deepEqual(
    status.edits.files.map(file => [file.path, file.kind]),
    [
      ['newdir/a.txt', 'extra'],
      ['scratch-notes.md', 'extra'],
      ['src/0.txt', 'edited'],
      ['src/1.txt', 'deleted'],
    ],
  );
  assert.match(status.edits.note, /Lane/);
  assert.ok(status.edits.files.find(file => file.path === 'scratch-notes.md').changedAt);
});

test('the status list is bounded while the count is complete', async t => {
  const f = pullFixture(t);
  for (let i = 0; i < 30; i++) fs.writeFileSync(join(f.root, `extra-${String(i).padStart(2, '0')}.txt`), 'x');
  const { edits } = await cloneFreshness(f.root, f.transport);
  assert.equal(edits.count, 30);
  assert.equal(edits.files.length, 20);
  assert.equal(edits.truncated, true);
});

test('pull names every obstructing path at once and leaves the files', async t => {
  const f = pullFixture(t);
  f.select([['src/2.txt', 'newer\n']]);
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'edited 0\n');
  fs.rmSync(join(f.root, 'src/1.txt'));
  await assert.rejects(
    pullHostedProject(f.root, f.address, f.transport),
    e =>
      e.code === 'WORK_CONFLICT' &&
      e.message.includes('"src/0.txt"') &&
      e.message.includes('"src/1.txt"') &&
      /Move your local edits into a Lane/.test(e.message) &&
      /carryEdits/.test(e.message),
  );
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'edited 0\n');
  assert.equal(fs.existsSync(join(f.root, 'src/1.txt')), false);
});

test('carry moves edits, deletions and new files into the Lane and leaves the clone clean', t => {
  const f = pullFixture(t);
  const { lane, files } = laneFor(f);
  stray(f);
  const edits = cloneLocalEdits(f.root);
  const result = carryCloneEdits(f.root, lane, edits, files);
  assert.equal(result.carried.length, 4);
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(join(lane, 'src/0.txt'), 'utf8'), 'edited 0\n');
  assert.equal(fs.existsSync(join(lane, 'src/1.txt')), false);
  assert.equal(fs.readFileSync(join(lane, 'scratch-notes.md'), 'utf8'), 'stray\n');
  assert.equal(fs.readFileSync(join(lane, 'newdir/a.txt'), 'utf8'), 'new\n');
  assert.equal(cloneLocalEdits(f.root).count, 0, 'clone is clean again');
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  assert.equal(fs.readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'source 1\n');
  assert.equal(fs.existsSync(join(f.root, 'newdir')), false);
});

test('carry refuses a path whose Lane baseline differs and leaves both copies untouched', t => {
  const f = pullFixture(t);
  const { lane, files } = laneFor(f);
  files.find(file => file.path === 'src/0.txt').blob = 'f'.repeat(64);
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'edited 0\n');
  const result = carryCloneEdits(f.root, lane, cloneLocalEdits(f.root), files);
  assert.deepEqual(result.carried, []);
  assert.equal(result.skipped[0].path, 'src/0.txt');
  assert.equal(fs.readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'edited 0\n');
  assert.equal(fs.readFileSync(join(lane, 'src/0.txt'), 'utf8'), 'source 0\n');
});

test('start without carryEdits names the edits and offers the carry; the clone is untouched', t => {
  const f = pullFixture(t);
  stray(f);
  const reply = noteCloneEdits(f.root, randomUUID(), { path: join(f.directory, 'lane') }, false, {
    record: recordLane,
  });
  assert.equal(reply.localEdits.count, 4);
  assert.match(reply.localEdits.note, /Lane/);
  assert.match(reply.localEdits.carry, /carryEdits/);
  assert.equal(reply.carriedEdits, undefined);
  assert.equal(cloneLocalEdits(f.root).count, 4);
  // A clean clone adds nothing to the reply.
  const clean = pullFixture(t);
  const plain = { path: 'x' };
  assert.equal(noteCloneEdits(clean.root, randomUUID(), plain, false, { record: recordLane }), plain);
});

test('the shape of 2026-11-23: edits, then start, then manual re-apply shows the warning at start', t => {
  const f = pullFixture(t);
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'builder edit\n');
  const edits = cloneLocalEdits(f.root);
  const notice = startEditsNotice(f.root, edits);
  assert.equal(notice.count, 1);
  assert.equal(notice.files[0].path, 'src/0.txt');
  assert.match(notice.note, /start first|work in a Lane/);
});

const registry = { read: readLaneEntry, record: recordLane };
test('a save from a Lane mentions newer clone edits once, not on every call', t => {
  const state = fs.mkdtempSync(
    join(fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'x-'))), 'state-'),
  );
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(state, { recursive: true, force: true });
  });
  const f = pullFixture(t);
  const laneId = randomUUID();
  const mark = fs.statSync(join(f.root, 'src/0.txt')).mtimeMs,
    opened = mark - 600_000;
  recordLane(
    {
      laneId,
      root: join(f.directory, 'lane'),
      url: 'https://fixture.invalid',
      projectId: 'project',
      cloneRoot: f.root,
    },
    opened,
  );
  assert.equal(readLaneEntry(laneId).cloneRoot, f.root);
  assert.equal(cloneEditsHeadsUp(laneId, registry, opened + 1), null, 'clean clone: nothing');
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'edited after start\n');
  const first = cloneEditsHeadsUp(laneId, registry, mark + 120_000);
  assert.match(first, /1 edit in the shared clone/);
  assert.match(first, /src\/0\.txt/);
  assert.equal(cloneEditsHeadsUp(laneId, registry, mark + 240_000), null, 'same set: said once');
  fs.writeFileSync(join(f.root, 'src/2.txt'), 'edited too\n');
  assert.match(cloneEditsHeadsUp(laneId, registry, mark + 360_000), /2 edits/);
});

function withState(t) {
  const state = fs.mkdtempSync(
    join(fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'x-'))), 'state-'),
  );
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(state, { recursive: true, force: true });
  });
}
const record = (laneId, f, opened) =>
  recordLane(
    {
      laneId,
      root: join(f.directory, 'lane'),
      url: 'https://fixture.invalid',
      projectId: 'p',
      cloneRoot: f.root,
    },
    opened,
  );

test('deletion-only edits count: the save notice names them', t => {
  withState(t);
  const f = pullFixture(t);
  const laneId = randomUUID();
  const opened = Date.parse('2030-01-01T00:00:00Z'); // later than any file time: only a deletion can trigger it
  record(laneId, f, opened);
  fs.rmSync(join(f.root, 'src/1.txt'));
  assert.match(cloneEditsHeadsUp(laneId, registry, opened + 1000), /1 edit in the shared clone.*src\/1\.txt/);
});

test("a Lane started from another Lane inherits that Lane's clone for the save notice", t => {
  withState(t);
  const f = pullFixture(t);
  const source = randomUUID(),
    child = randomUUID();
  record(source, f);
  const lane = join(f.directory, 'lane2');
  fs.mkdirSync(join(lane, '.forge'), { recursive: true });
  fs.writeFileSync(join(lane, '.forge', 'hosted-lane.json'), '{}');
  recordLane({
    laneId: child,
    root: join(f.directory, 'lane3'),
    url: 'https://fixture.invalid',
    projectId: 'p',
  });
  const plain = { path: 'x' };
  assert.equal(noteCloneEdits(lane, child, plain, false, registry, source), plain);
  assert.equal(readLaneEntry(child).cloneRoot, f.root);
});

test('carry on a clone behind main says exactly why a changed path stays', t => {
  const f = pullFixture(t);
  const { lane, files } = laneFor(f);
  files.find(file => file.path === 'src/0.txt').blob = 'f'.repeat(64); // main changed 0 after the pull
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'edited 0\n');
  fs.writeFileSync(join(f.root, 'src/2.txt'), 'edited 2\n');
  const result = carryCloneEdits(f.root, lane, cloneLocalEdits(f.root), files);
  assert.deepEqual(result.carried, []);
  assert.match(result.skipped[0].reason, /main changed this file since the clone was last pulled/);
  assert.equal(fs.readFileSync(join(f.root, 'src/2.txt'), 'utf8'), 'edited 2\n', 'all or nothing');
  // Edits to files main did not touch carry once the conflicting one is back at baseline.
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'source 0\n');
  const rest = carryCloneEdits(f.root, lane, cloneLocalEdits(f.root), files);
  assert.deepEqual(rest.carried, ['src/2.txt']);
});

test('start from a dirty clone: warning with a registered clone, not-ready carry loses nothing', t => {
  withState(t);
  const f = pullFixture(t);
  const { lane } = laneFor(f);
  stray(f);
  const laneId = randomUUID();
  recordLane({ laneId, root: lane, url: 'https://fixture.invalid', projectId: 'p' }); // start records first
  const warn = noteCloneEdits(f.root, laneId, { path: lane }, false, registry);
  assert.equal(warn.localEdits.count, 4);
  assert.equal(readLaneEntry(laneId).cloneRoot, f.root);
  const reply = noteCloneEdits(
    f.root,
    laneId,
    { path: lane, checkout: { status: 'incomplete' } },
    true,
    registry,
  );
  assert.equal(reply.carriedEdits.carried, 0);
  assert.match(reply.carriedEdits.note, /not ready/);
  assert.equal(cloneLocalEdits(f.root).count, 4);
});
