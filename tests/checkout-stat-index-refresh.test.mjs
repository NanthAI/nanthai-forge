// SPDX-License-Identifier: Apache-2.0
// Racily clean stat-index entries (files changed just before they were indexed) are re-read until a
// complete clean pass sees them safely old, then trusted, as Git refreshes its index. A file written
// inside the racy window is never trusted on its lstat alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstatSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { indexedBlob, readCheckoutStatIndex, statEntry } from '../dist/checkout-stat-index.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { installHostedCheckout } from '../dist/hosted-checkout-files.js';

const indexPath = root => join(clientCacheRoot(root), 'checkout-stat.json');
/** Checkout files read by `run`, relative to root (marker and cache reads excluded). */
async function checkoutReads(t, root, run) {
  const read = fs.readFileSync,
    paths = [];
  t.mock.method(fs, 'readFileSync', (path, ...rest) => {
    const text = String(path);
    if (text.startsWith(`${root}/`) && !text.startsWith(`${root}/.forge/`))
      paths.push(text.slice(root.length + 1));
    return read(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    return { value: await run(), paths: paths.sort() };
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}
const trusted = (root, path) => {
  const file = readHostedLaneCheckout(root).state.files.find(item => item.path === path);
  return indexedBlob(readCheckoutStatIndex(root), path, lstatSync(join(root, path)), file.blob) === file.blob;
};

test('files installed in place are re-read once after they age, then trusted by every later check', async t => {
  const s = await fixture(t, undefined, [{ path: 'b', content: 'b before\n' }]);
  s.setFiles(s.files.map(file => (file.path === 'a' ? { ...file, blob: s.put('after\n') } : file)));
  await applyHostedSync(s.root, s.command(), s.transport);
  // Just renamed into place: inside the racy window, so never trusted on its lstat yet.
  assert.equal(trusted(s.root, 'a'), false);
  await delay(250);
  const first = await checkoutReads(t, s.root, () => hostedLaneDirty(s.root, { refresh: true }));
  assert.equal(first.value, false);
  assert(first.paths.includes('a'), `the installed file is re-read once: ${first.paths}`);
  assert.equal(trusted(s.root, 'a'), true, 'the clean pass refreshed the racy entry');
  const second = await checkoutReads(t, s.root, () => hostedLaneDirty(s.root, { refresh: true }));
  assert.equal(second.value, false);
  assert.deepEqual(second.paths, [], 'nothing is re-read once refreshed');
  // An edit after the refresh is still seen (new ctime, new size).
  writeFileSync(join(s.root, 'a'), 'edited after refresh\n');
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), true);
});

test('a refresh never trusts a file written inside the racy window, even with its old mtime restored', async t => {
  const s = await fixture(t, undefined, [{ path: 'b', content: 'b before\n' }]);
  rmIndex(s.root);
  await delay(250);
  // 'b' is rewritten (same bytes) just before the pass: racy at pass time.
  const old = lstatSync(join(s.root, 'b'));
  writeFileSync(join(s.root, 'b'), 'b before\n');
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), false);
  assert.equal(trusted(s.root, 'a'), true, 'an old file is refreshed');
  assert.equal(trusted(s.root, 'b'), false, 'a file inside the window stays racy');
  // Same size, mtime set back to its indexed value: ctime still moves, so the edit is read.
  const entry = readCheckoutStatIndex(s.root).entries.get('b');
  writeFileSync(join(s.root, 'b'), 'b EDITED\n'.slice(0, old.size));
  utimesSync(join(s.root, 'b'), new Date(entry[1]), new Date(entry[1]));
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), true);
});

test('housekeeping probes and dirty passes write no index; an all-trusted pass rewrites none', async t => {
  const s = await fixture(t, undefined, [{ path: 'b', content: 'b before\n' }]);
  rmIndex(s.root);
  await delay(250);
  writeFileSync(join(s.root, 'b'), 'local edit\n');
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), true);
  assert.equal(fs.existsSync(indexPath(s.root)), false, 'a dirty pass leaves the index alone');
  writeFileSync(join(s.root, 'b'), 'b before\n');
  await delay(250);
  // Lane housekeeping and cache GC probe without refresh: nothing in the Lane looks used.
  assert.equal(hostedLaneDirty(s.root), false);
  assert.equal(fs.existsSync(indexPath(s.root)), false, 'a probe without refresh writes nothing');
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), false);
  const written = lstatSync(indexPath(s.root)).mtimeMs;
  await delay(20);
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), false);
  assert.equal(lstatSync(indexPath(s.root)).mtimeMs, written, 'an all-trusted pass does not rewrite');
});

test('an index whose client clock ran ahead of the file system is bounded by its own mtime', async t => {
  const s = await fixture(t);
  const path = join(s.root, 'a');
  writeFileSync(path, readFileSync(path)); // Written just now, by the file system's clock.
  const stat = lstatSync(path);
  // Written by a client whose clock is an hour ahead: every entry would look an hour old.
  writeFileSync(
    indexPath(s.root),
    JSON.stringify({
      schema: 1,
      since: Date.now() + 3_600_000,
      entries: { a: statEntry(stat, digest(readFileSync(path))) },
    }),
  );
  const index = readCheckoutStatIndex(s.root);
  assert(index.since <= lstatSync(indexPath(s.root)).mtimeMs);
  // The file was written moments before the index, so it is racy by the file system's clock.
  assert.equal(indexedBlob(index, 'a', stat, digest(readFileSync(path))), undefined);
});

function rmIndex(root) {
  fs.rmSync(indexPath(root), { force: true });
}

test('Issue 44ef42b9: eol=crlf files check out, sync, stay clean and save as git does', async t => {
  const rules = { path: '.gitattributes', content: '*.bat text eol=crlf\n' };
  const s = await fixture(t, undefined, [rules, { path: 'gradlew.bat', content: '@echo off\nset A=1\n' }]);
  const bat = join(s.root, 'gradlew.bat');
  assert.equal(readFileSync(bat, 'utf8'), '@echo off\r\nset A=1\r\n', 'the working tree has CRLF');
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'before\n', 'files without a rule are untouched');
  // Inside the racy window the check reads the CRLF bytes and matches them to the LF blob.
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), false, 'a converted checkout is clean');
  // A sync that changes the file installs it converted, with no edit kept aside.
  const later = s.put('@echo off\nset A=2\n');
  s.setFiles(s.files.map(file => (file.path === 'gradlew.bat' ? { ...file, blob: later } : file)));
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(readFileSync(bat, 'utf8'), '@echo off\r\nset A=2\r\n');
  assert.equal(
    readHostedLaneCheckout(s.root).state.files.find(file => file.path === 'gradlew.bat').blob,
    later,
  );
  assert.equal(hostedLaneDirty(s.root, { refresh: true }), false);
  // An edit saves the LF bytes Git stores.
  writeFileSync(bat, '@echo off\r\nset A=3\r\n');
  const capture = await captureHostedSave(s.root, join(s.root, '..', 'capture'));
  assert.deepEqual(
    capture.changes.map(change => [change.path, change.after?.blob]),
    [['gradlew.bat', digest('@echo off\nset A=3\n')]],
  );
  // A Candidate checkout from verified objects converts the same way.
  const objects = join(s.root, '..', 'objects'),
    candidate = join(s.root, '..', 'candidate');
  fs.mkdirSync(objects);
  for (const [id, bytes] of s.objects) writeFileSync(join(objects, id), bytes);
  const files = readHostedLaneCheckout(s.root).state.files;
  await installHostedCheckout(candidate, objects, files);
  assert.equal(readFileSync(join(candidate, 'gradlew.bat'), 'utf8'), '@echo off\r\nset A=2\r\n');
});
