// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldedCollisions } from '../dist/native-state-format.js';
import {
  installHostedCheckout,
  installHostedFile,
  probeNameFolding,
  stageHostedFiles,
} from '../dist/hosted-checkout-files.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-collision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = join(directory, 'objects'),
    outside = join(directory, 'outside');
  mkdirSync(objects);
  mkdirSync(outside);
  const blob = text => {
    const bytes = Buffer.from(text);
    writeFileSync(join(objects, sha(bytes)), bytes);
    return sha(bytes);
  };
  return { directory, objects, outside, blob };
}

test('folded collisions are named for the folding the volume has, and only then', () => {
  const files = [{ path: 'Lib' }, { path: 'lib/evil.plist' }, { path: 'src/a.ts' }, { path: 'SRC/b.ts' }];
  const sensitive = { caseInsensitive: false, unicodeInsensitive: false };
  assert.deepEqual(foldedCollisions(files, sensitive), []);
  // A name and a folder in another case; two directories in different case are not a collision.
  assert.deepEqual(foldedCollisions(files, { ...sensitive, caseInsensitive: true }), ['Lib']);
  assert.deepEqual(
    foldedCollisions([{ path: 'A.txt' }, { path: 'a.txt' }], { ...sensitive, caseInsensitive: true }),
    ['A.txt', 'a.txt'],
  );
  // "é" as one code point and as "e" plus a combining accent are one name on a normalising volume.
  const unicode = [{ path: 'café.txt' }, { path: 'café.txt' }];
  assert.deepEqual(foldedCollisions(unicode, sensitive), []);
  assert.equal(foldedCollisions(unicode, { ...sensitive, unicodeInsensitive: true }).length, 2);
});

test('a link and a file below the same name in another case never write outside the checkout', async t => {
  const f = fixture(t);
  const checkout = join(f.directory, 'checkout');
  const files = [
    { path: 'Lib', mode: 'symlink', blob: f.blob(f.outside) },
    { path: 'lib/evil.plist', mode: 'file', blob: f.blob('payload') },
  ];
  mkdirSync(checkout);
  const folding = probeNameFolding(checkout);
  if (folding.caseInsensitive) {
    await assert.rejects(installHostedCheckout(checkout, f.objects, files), /share one name on this volume/);
  } else {
    // A case-sensitive volume keeps both names: the file lands in its own directory.
    await installHostedCheckout(checkout, f.objects, files);
    assert.equal(readFileSync(join(checkout, 'lib/evil.plist'), 'utf8'), 'payload');
  }
  assert.deepEqual(readdirSync(f.outside), [], 'nothing was written through the link');
  assert.deepEqual(
    readdirSync(checkout).filter(name => name.startsWith('.forge-fold')),
    [],
    'the probe files are removed',
  );
});

test('links are installed after files and a link never replaces a directory or is written through', async t => {
  const f = fixture(t);
  const checkout = join(f.directory, 'checkout');
  // A State that bypassed parsing: the link `d` and a file below it.
  const files = [
    { path: 'd', mode: 'symlink', blob: f.blob(f.outside) },
    { path: 'd/x.txt', mode: 'file', blob: f.blob('inside') },
  ];
  const refused = /EEXIST|share one name on this volume/;
  await assert.rejects(installHostedCheckout(checkout, f.objects, files), refused);
  assert.deepEqual(readdirSync(f.outside), []);
  // On a volume that cannot tell the names apart the State is refused before anything is written.
  if (existsSync(join(checkout, 'd'))) {
    assert.equal(readFileSync(join(checkout, 'd/x.txt'), 'utf8'), 'inside');
    assert.equal(lstatSync(join(checkout, 'd')).isDirectory(), true);
  }

  // A well-formed State places links last and keeps them as links.
  const clean = join(f.directory, 'clean');
  await installHostedCheckout(clean, f.objects, [
    { path: 'a.txt', mode: 'file', blob: f.blob('a') },
    { path: 'link', mode: 'symlink', blob: f.blob('a.txt') },
    { path: 'sub/b.txt', mode: 'executable', blob: f.blob('b') },
  ]);
  assert.equal(lstatSync(join(clean, 'link')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(clean, 'link'), 'utf8'), 'a');
  assert.equal(existsSync(join(clean, 'sub/b.txt')), true);
});

test('a file is never copied over an existing link', t => {
  const f = fixture(t);
  const stage = join(f.directory, 'stage');
  mkdirSync(stage);
  writeFileSync(join(f.outside, 'target'), 'original');
  symlinkSync(join(f.outside, 'target'), join(stage, 'x'));
  assert.throws(
    () => installHostedFile(stage, f.objects, { path: 'x', mode: 'file', blob: f.blob('payload') }),
    /EEXIST/,
  );
  assert.equal(readFileSync(join(f.outside, 'target'), 'utf8'), 'original');
});

test('staging a checkout refuses colliding names before writing any file', async t => {
  const f = fixture(t);
  const stage = join(f.directory, 'stage');
  mkdirSync(stage);
  const folding = probeNameFolding(stage);
  const files = [
    { path: 'Readme.md', mode: 'file', blob: f.blob('one') },
    { path: 'README.md', mode: 'file', blob: f.blob('two') },
  ];
  if (!folding.caseInsensitive) return t.skip('this volume keeps names that differ by case apart');
  await assert.rejects(() => stageHostedFiles(stage, f.objects, files), /share one name on this volume/);
  assert.deepEqual(readdirSync(stage), []);
});

test('the install gives the event loop a turn between files and stops writing once interrupted (Issue 57a557e9)', async t => {
  const f = fixture(t);
  const files = Array.from({ length: 40 }, (_, index) => ({
    path: `d${index % 5}/f${index}.txt`,
    mode: 'file',
    blob: f.blob(`body ${index}`),
  }));
  // A callback on the event loop (as the worker's lease heartbeat and abort deadline are) must run mid-install.
  let timerFiredAt = -1,
    seen = 0;
  const first = join(f.directory, 'first');
  setImmediate(() => {
    timerFiredAt = seen;
  });
  await installHostedCheckout(first, f.objects, files, { interrupt: () => void seen++, sliceMs: 0 });
  assert.ok(timerFiredAt >= 0 && timerFiredAt < files.length, 'the timer ran before the install finished');

  // A lost lease aborts through `interrupt`; no file after it is written.
  const stopped = join(f.directory, 'stopped');
  const abort = new AbortController();
  let installed = 0;
  setImmediate(() => abort.abort());
  await assert.rejects(
    installHostedCheckout(stopped, f.objects, files, {
      interrupt: () => (installed++, abort.signal.throwIfAborted()),
      sliceMs: 0,
      durable: false,
    }),
    { name: 'AbortError' },
  );
  assert.ok(installed < files.length, 'the install ended before all files');
  const written = files.filter(file => existsSync(join(stopped, file.path))).length;
  assert.ok(written < files.length - 1 && written <= installed, 'no file was written after the abort');
});
