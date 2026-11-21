// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';

const baselineFiles = Array.from({ length: 9997 }, (_, index) => [
  `fixture/${Math.floor(index / 100)}/${index}.txt`,
  'unchanged\n',
]);

for (const dirty of [false, true])
  test(`save --sync installs changed main with at most two walks at 10k files (${dirty ? 'dirty' : 'clean'})`, async t => {
    const s = await resolutionFixture(t, { baselineFiles });
    await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
    const root = fs.realpathSync(s.root);
    assert.equal(s.f.files(s.f.lane.head).length, 10000);
    s.f.moveMain();
    const bytes = 'my checkout edit\n';
    if (dirty) fs.writeFileSync(join(root, 'a.txt'), bytes);
    const { readdirSync, lstatSync } = fs;
    let walks = 0;
    let stats = 0;
    t.mock.method(fs, 'readdirSync', (path, ...args) => {
      if (path === root) walks++;
      return readdirSync(path, ...args);
    });
    t.mock.method(fs, 'lstatSync', (path, ...args) => {
      if (path === root || (typeof path === 'string' && path.startsWith(root + '/'))) stats++;
      return lstatSync(path, ...args);
    });
    syncBuiltinESMExports();
    let synced;
    try {
      synced = await s.transport().dispatch('sync', { laneId: s.f.lane.laneId, apply: true });
    } finally {
      fs.readdirSync.mock.restore();
      fs.lstatSync.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(synced.result.saved?.status, dirty ? 'completed' : undefined);
    assert.equal(fs.readFileSync(join(root, 'accepted.txt'), 'utf8'), 'already accepted\n');
    if (dirty) assert.equal(s.f.text(synced.result.applied.head, 'a.txt'), bytes);
    t.diagnostic(`${walks} checkout root enumerations, ${stats} checkout lstats`);
    assert(walks <= 2);
  });

test('save --sync still reports a disjoint edit written during publication', async t => {
  const s = await resolutionFixture(t);
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const root = fs.realpathSync(s.root);
  s.f.moveMain();
  const addition = join(root, 'accepted.txt');
  const late = join(root, 'late.txt');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === addition) fs.writeFileSync(late, 'after the install began\n');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(s.transport().dispatch('sync', { laneId: s.f.lane.laneId, apply: true }), error => {
      assert.equal(error.code, 'UNSAVED_LANE_EDITS');
      assert.deepEqual(error.recovery.unsaved, { count: 1, paths: ['late.txt'] });
      assert.equal(error.recovery.completed.applied.laneId, s.f.lane.laneId);
      return true;
    });
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(addition, 'utf8'), 'already accepted\n');
  assert.equal(fs.readFileSync(late, 'utf8'), 'after the install began\n');
});

test('save --sync only walks disjoint directories before capture and after publication', async t => {
  const s = await resolutionFixture(t, { baselineFiles: [['disjoint/source.txt', 'unchanged\n']] });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const root = fs.realpathSync(s.root);
  s.f.moveMain({ overlap: true });
  const readdir = fs.readdirSync;
  let disjointWalks = 0;
  t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === join(root, 'disjoint')) disjointWalks++;
    return readdir(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await s.transport().dispatch('sync', { laneId: s.f.lane.laneId, apply: true });
  } finally {
    fs.readdirSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'theirs\nb\nc\n');
  assert(disjointWalks <= 2, 'publication did not enumerate the untouched directory');
});

test('save --sync refreshes its inventory when an ignore file appears before capture', async t => {
  const s = await resolutionFixture(t);
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const root = fs.realpathSync(s.root);
  const local = join(root, 'local.txt');
  fs.writeFileSync(local, 'keep in this checkout\n');
  s.f.moveMain();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to).startsWith(root + '.forge-client/saves/') && String(to).endsWith('/command.json'))
      fs.writeFileSync(join(root, '.forgeignore'), 'local.txt\n');
  });
  syncBuiltinESMExports();
  let synced;
  try {
    synced = await s.transport().dispatch('sync', { laneId: s.f.lane.laneId, apply: true });
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(synced.result.saved.status, 'completed');
  assert.equal(s.f.text(synced.result.applied.head, '.forgeignore'), 'local.txt\n');
  assert.equal(s.f.text(synced.result.applied.head, 'local.txt'), null);
  assert.equal(fs.readFileSync(local, 'utf8'), 'keep in this checkout\n');
});
