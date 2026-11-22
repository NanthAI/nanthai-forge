// SPDX-License-Identifier: Apache-2.0
// Issue 48835eea cost line: the final check of a saving reply reuses the save's own recorded source
// walk (Git's untracked cache: directory and ignore-file lstats) instead of walking the tree again.
// It never trusts file events. Anything that could change the walk's result makes it walk again, so
// a left-out edit is always named.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { unsavedPaths } from '../dist/hosted-save-receipt-state.js';
import { cachedSourcePaths, treeRecorder } from '../dist/checkout-stat-index.js';
import { scanSourcePaths } from '../dist/source-paths.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';

/** Checkout directories listed while `run` runs (its .forge metadata excluded). */
async function listings(t, root, run) {
  const readdir = fs.readdirSync,
    listed = [];
  const mocked = t.mock.method(fs, 'readdirSync', (path, ...rest) => {
    const text = String(path);
    if ((text === root || text.startsWith(`${root}/`)) && !text.startsWith(`${root}/.forge`))
      listed.push(text.slice(root.length + 1));
    return readdir(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    return { value: await run(), listed };
  } finally {
    // Only this mock: a fixture's own clock mock must keep its restore order (Item 9a04d916).
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
}

/** Stamp the walks recorded inside `run` 3 s later, on the client clock and the file-system clock
 * (the record's own mtime bounds its start) alike: as if each walk began after its directories last
 * changed. An injected clock instead of a fixed sleep (lint guard ffbec6ef). */
async function recordLater(t, run) {
  const stamp = mkdtempSync(join(tmpdir(), 'forge-tree-time-'));
  const later = Math.ceil(lstatSync(stamp).ctimeMs) + 3000;
  rmSync(stamp, { recursive: true });
  const rename = fs.renameSync;
  const clock = t.mock.method(Date, 'now', () => later),
    renamed = t.mock.method(fs, 'renameSync', (from, to) => {
      rename(from, to);
      if (String(to).endsWith('/checkout-tree.json')) fs.utimesSync(to, later / 1000, later / 1000);
    });
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    // Only these mocks: a fixture's own clock mock keeps its restore order (Item 9a04d916).
    renamed.mock.restore();
    clock.mock.restore();
    syncBuiltinESMExports();
  }
}

async function recorded(t) {
  const s = await fixture(t, undefined, [
    { path: 'docs/guide.md', content: 'guide\n' },
    { path: '.gitignore', content: '*.log\n' },
  ]);
  writeFileSync(join(s.root, 'docs', 'build.log'), 'ignored output\n');
  const first = await recordLater(t, () => unsavedPaths(s.root));
  assert.deepEqual(first, [], 'the first check walks and records');
  return s.root;
}

test('48835eea cost: a check while the recorded walk holds lists no directory, and an in-place edit is still named', async t => {
  const root = await recorded(t);
  const clean = await listings(t, root, () => unsavedPaths(root));
  assert.deepEqual(clean.value, []);
  assert.deepEqual(clean.listed, [], 'no source walk');
  writeFileSync(join(root, 'docs', 'guide.md'), 'edited in place\n');
  const edited = await listings(t, root, () => unsavedPaths(root));
  assert.deepEqual(edited.value, ['docs/guide.md']);
  assert.deepEqual(edited.listed, [], 'an in-place edit is found by the per-file lstat pass, no walk');
});

test('48835eea degraded: a new file walks again and is named, even with its directory mtime set back', async t => {
  const root = await recorded(t);
  const before = lstatSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'new.md'), 'left out?\n');
  utimesSync(join(root, 'docs'), before.atime, before.mtime);
  const found = await listings(t, root, () => unsavedPaths(root));
  assert.deepEqual(found.value, ['docs/new.md'], 'the ctime still moved');
  assert(found.listed.includes('docs'), `it walked: ${found.listed}`);
});

test('48835eea degraded: an ignore file rewritten in place (no directory change) walks again and names what it un-ignores', async t => {
  const root = await recorded(t);
  writeFileSync(join(root, '.gitignore'), '# nothing ignored now\n');
  const found = await listings(t, root, () => unsavedPaths(root));
  assert.deepEqual(found.value, ['.gitignore', 'docs/build.log']);
  assert(found.listed.length > 0, 'it walked');
});

test('48835eea degraded: a new folder of files is named, and a later file inside it too', async t => {
  const root = await recorded(t);
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'deep', 'one.ts'), 'export {};\n');
  assert.deepEqual(unsavedPaths(root), ['src/deep/one.ts']);
  writeFileSync(join(root, 'src', 'deep', 'two.ts'), 'export {};\n');
  const found = await listings(t, root, () => unsavedPaths(root));
  assert.deepEqual(found.value, ['src/deep/one.ts', 'src/deep/two.ts']);
  assert(found.listed.includes('src/deep'), `it walked: ${found.listed}`);
});

test('checkout inventory observes a change directly under a directory named __proto__', async t => {
  const root = await recorded(t);
  const directory = join(root, '__proto__');
  mkdirSync(directory);
  const tree = await recordLater(t, () => {
    const tree = treeRecorder(root);
    scanSourcePaths(root, { retained: tracked(root), tree });
    return tree;
  });
  assert(tree.stillCurrent());
  writeFileSync(join(directory, 'late.txt'), 'late source\n');
  assert.equal(tree.stillCurrent(), false);
  assert.equal(cachedSourcePaths(root, tracked(root)), undefined);
  assert.deepEqual(unsavedPaths(root), ['__proto__/late.txt']);
});

test('48835eea cost: a save lists each checkout directory once, its final check reusing the capture walk', async t => {
  const s = await resolutionFixture(t, { overlap: false });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const root = realpathSync(s.root);
  writeFileSync(join(root, 'a.txt'), 'edited in place before the save\n');
  // (The fixture freezes Date.now: without recordLater every directory stays racy and the check walks.)
  const saved = await listings(t, root, () => recordLater(t, () => s.transport().dispatch('save', {})));
  assert.equal(saved.value.result.outcome.status, 'completed');
  const repeated = saved.listed.filter((path, index) => saved.listed.indexOf(path) !== index);
  assert.deepEqual(repeated, [], `each directory is listed once (capture), never again by the final check`);
  assert(saved.listed.length > 0, 'the capture walked');
  assert.deepEqual(unsavedPaths(root), []);
});

const tracked = root => readHostedLaneCheckout(root).state.files.map(file => file.path);

test('48835eea: a record is reused for another tracked set only where retention cannot change the walk', async t => {
  const root = await recorded(t),
    saved = tracked(root);
  assert.deepEqual(cachedSourcePaths(root, saved)?.sort(), [...saved].sort(), 'same set: reused');
  // Newly tracking an ignored file would make a fresh walk return it: never reused.
  assert.equal(cachedSourcePaths(root, [...saved, 'docs/build.log']), undefined);
  // Untracking a returned file could make a fresh walk drop it: never reused.
  assert.equal(
    cachedSourcePaths(
      root,
      saved.filter(path => path !== 'a'),
    ),
    undefined,
  );
  // A save that deleted a tracked file: the walk recorded it as tracked and absent; reused after.
  const withGone = [...saved, 'gone.txt'];
  const paths = await recordLater(t, () =>
    scanSourcePaths(root, { retained: withGone, tree: treeRecorder(root) }),
  );
  assert.deepEqual(cachedSourcePaths(root, saved), paths);
  // A save that added a returned file: tracked now, returned then; reused.
  writeFileSync(join(root, 'docs', 'added.md'), 'new\n');
  const after = await recordLater(t, () =>
    scanSourcePaths(root, { retained: saved, tree: treeRecorder(root) }),
  );
  assert(after.includes('docs/added.md'));
  assert.deepEqual(cachedSourcePaths(root, [...saved, 'docs/added.md']), after);
});

test('48835eea review: where a new entry does not move its directory stat, an older record is removed and every check walks', async t => {
  const root = await recorded(t);
  assert(cachedSourcePaths(root, tracked(root)), 'a record from a working file system');
  // The same checkout now behaves like a mount whose directory stats never move (FUSE, network).
  const lstat = fs.lstatSync;
  const frozen = t.mock.method(fs, 'lstatSync', (path, ...rest) => {
    const stat = lstat(path, ...rest);
    if (String(path).includes('tree-probe-')) Object.defineProperty(stat, 'mtimeMs', { value: 0 });
    return stat;
  });
  syncBuiltinESMExports();
  try {
    writeFileSync(join(root, 'docs', 'new.md'), 'new\n');
    assert.deepEqual(await recordLater(t, () => unsavedPaths(root)), ['docs/new.md']);
  } finally {
    frozen.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(cachedSourcePaths(root, tracked(root)), undefined, 'the older record is gone too');
  const walked = await listings(t, root, () => unsavedPaths(root));
  assert(walked.listed.length > 0, 'it walked');
});

test('48835eea review: a folder on another device inside the checkout (a mount) leaves no record', async t => {
  const root = await recorded(t);
  const lstat = fs.lstatSync,
    docs = join(root, 'docs');
  const mounted = t.mock.method(fs, 'lstatSync', (path, ...rest) => {
    const stat = lstat(path, ...rest);
    if (String(path) === docs) Object.defineProperty(stat, 'dev', { value: stat.dev + 1 });
    return stat;
  });
  syncBuiltinESMExports();
  try {
    await recordLater(t, () => scanSourcePaths(root, { retained: tracked(root), tree: treeRecorder(root) }));
  } finally {
    mounted.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(cachedSourcePaths(root, tracked(root)), undefined);
});
