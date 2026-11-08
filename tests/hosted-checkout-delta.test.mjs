// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { racyMarginMs, statEntry, writeCheckoutStatIndex } from '../dist/checkout-stat-index.js';

const tree = Array.from({ length: 2000 }, (_, i) => ({
  path: `src/d${Math.floor(i / 50)}/file-${i}.ts`,
  content: `export const value${i} = ${i};\n`,
}));
/** Count the file work an apply does inside the checkout and its private stages. */
function meter(t, root) {
  const counts = { sourceReads: 0, clones: 0, flushes: 0 };
  const inRoot = path => String(path).startsWith(`${root}/`) && !String(path).startsWith(`${root}/.forge/`);
  const readFile = fs.readFileSync,
    openFile = fs.openSync,
    copy = fs.promises.copyFile,
    open = fs.promises.open;
  t.mock.method(fs, 'readFileSync', (path, ...rest) => {
    if (inRoot(path)) counts.sourceReads++;
    return readFile(path, ...rest);
  });
  t.mock.method(fs, 'openSync', (path, ...rest) => {
    if (inRoot(path)) counts.sourceReads++;
    return openFile(path, ...rest);
  });
  t.mock.method(fs.promises, 'copyFile', (...args) => {
    counts.clones++;
    return copy(...args);
  });
  t.mock.method(fs.promises, 'open', (...args) => {
    counts.flushes++;
    return open(...args);
  });
  syncBuiltinESMExports();
  return {
    counts,
    restore: () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
/** Re-index the checkout once its files are older than the racy window, as a save would, so
 * the stat index vouches for every unchanged file and any whole-tree read shows up exactly. */
async function settledIndex(root) {
  const marker = readHostedLaneCheckout(root),
    paths = marker.state.files.map(file => [file.path, file.blob]);
  const margin = Math.max(...paths.map(([path]) => racyMarginMs(lstatSync(join(root, path)))));
  await new Promise(resolve => setTimeout(resolve, margin + 50));
  writeCheckoutStatIndex(
    root,
    Date.now(),
    new Map(paths.map(([path, blob]) => [path, statEntry(lstatSync(join(root, path)), blob)])),
  );
}

test('a one-file sync on a 2,000-file checkout reads, clones and flushes only the changed path', async t => {
  const s = await fixture(t, undefined, tree);
  await settledIndex(s.root);
  const before = new Map(tree.map(file => [file.path, lstatSync(join(s.root, file.path)).ino]));
  const request = s.command(),
    metered = meter(t, s.root);
  try {
    await applyHostedSync(s.root, request, s.transport);
  } finally {
    metered.restore();
  }
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  // One verification read of the displaced old bytes; every unchanged file is vouched by lstat.
  assert.equal(metered.counts.sourceReads, 1, JSON.stringify(metered.counts));
  assert.equal(metered.counts.clones, 1);
  assert(metered.counts.flushes <= 8, JSON.stringify(metered.counts));
  assert.deepEqual(s.reads.length, 2, 'State and the one changed object');
  for (const file of tree) assert.equal(lstatSync(join(s.root, file.path)).ino, before.get(file.path));
  assert.equal(readHostedLaneCheckout(s.root).selection.head, request.lane.head);
  assert(!readdirSync(clientCacheRoot(s.root)).some(name => name.startsWith('delta-')));
});

test('in-place apply removes deleted files and emptied directories and keeps ignored output in place', async t => {
  const rules = [{ path: '.gitignore', content: '/out/\n' }];
  const s = await fixture(t, undefined, [
    ...rules,
    { path: 'gone/only.txt', content: 'deleted upstream' },
    { path: 'kept/dir/old.txt', content: 'deleted upstream' },
    { path: 'kept/stays.txt', content: 'stays' },
  ]);
  mkdirSync(join(s.root, 'out'));
  writeFileSync(join(s.root, 'out/build.js'), 'local build output');
  const outInode = lstatSync(join(s.root, 'out/build.js')).ino;
  const keep = new Set(['gone/only.txt', 'kept/dir/old.txt']);
  s.setFiles([
    ...readHostedLaneCheckout(s.root).state.files.filter(file => !keep.has(file.path)),
    { path: 'new/added.txt', blob: s.put('added upstream'), mode: 'executable' },
  ]);
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(existsSync(join(s.root, 'gone')), false);
  assert.equal(existsSync(join(s.root, 'kept/dir')), false);
  assert.equal(readFileSync(join(s.root, 'kept/stays.txt'), 'utf8'), 'stays');
  assert.equal(readFileSync(join(s.root, 'new/added.txt'), 'utf8'), 'added upstream');
  assert(lstatSync(join(s.root, 'new/added.txt')).mode & 0o100);
  assert.equal(lstatSync(join(s.root, 'out/build.js')).ino, outInode);
  assert.equal(readFileSync(join(s.root, 'out/build.js'), 'utf8'), 'local build output');
});

test('an edit racing the in-place install is restored in place and refused', async t => {
  const s = await fixture(t),
    request = s.command();
  const marker = readFileSync(join(s.root, '.forge', 'hosted-lane.json'));
  const rename = fs.renameSync;
  let raced = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!raced && from === join(s.root, 'a')) {
      raced = true;
      writeFileSync(from, 'racing local edit');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert(raced);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'racing local edit');
  assert.deepEqual(readFileSync(join(s.root, '.forge', 'hosted-lane.json')), marker);
  assert(!readdirSync(clientCacheRoot(s.root)).some(name => name.startsWith('delta-')));
});
test('an untracked obstruction refuses a sync before any object is fetched or staged', async t => {
  const s = await fixture(t);
  // A folder holding only unsaved Finder state sits where the sync brings a file.
  s.setFiles([
    { ...s.files[0], blob: s.put('after\n') },
    ...s.files.slice(1),
    { path: 'dist', blob: s.put('incoming file\n'), mode: 'file' },
  ]);
  const command = s.command();
  mkdirSync(join(s.root, 'dist'));
  writeFileSync(join(s.root, 'dist/.DS_Store'), 'finder');
  const mkdtemp = fs.mkdtempSync,
    stages = [];
  t.mock.method(fs, 'mkdtempSync', (prefix, ...rest) => {
    stages.push(String(prefix).slice(String(prefix).lastIndexOf('/') + 1));
    return mkdtemp(prefix, ...rest);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyHostedSync(s.root, command, s.transport), error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      // The typed local-apply refusal, with recover-apply as the next step.
      assert.deepEqual(error.recovery.blockers, [{ kind: 'extra-source', path: 'dist' }]);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  // Only the selected State is read; no changed blob is fetched and no stage is built.
  assert.deepEqual(s.reads, [command.lane.head]);
  assert.deepEqual(
    stages.filter(name => /^(delta|checkout)-$/.test(name)),
    [],
    stages.join(','),
  );
  assert.equal(readFileSync(join(s.root, 'dist/.DS_Store'), 'utf8'), 'finder');
  assert.equal(readHostedLaneCheckout(s.root).selection.head, s.from.head);
});
