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

test('a link and a file below the same name in another case never write outside the checkout', t => {
  const f = fixture(t);
  const checkout = join(f.directory, 'checkout');
  const files = [
    { path: 'Lib', mode: 'symlink', blob: f.blob(f.outside) },
    { path: 'lib/evil.plist', mode: 'file', blob: f.blob('payload') },
  ];
  mkdirSync(checkout);
  const folding = probeNameFolding(checkout);
  if (folding.caseInsensitive) {
    assert.throws(() => installHostedCheckout(checkout, f.objects, files), /share one name on this volume/);
  } else {
    // A case-sensitive volume keeps both names: the file lands in its own directory.
    installHostedCheckout(checkout, f.objects, files);
    assert.equal(readFileSync(join(checkout, 'lib/evil.plist'), 'utf8'), 'payload');
  }
  assert.deepEqual(readdirSync(f.outside), [], 'nothing was written through the link');
  assert.deepEqual(
    readdirSync(checkout).filter(name => name.startsWith('.forge-fold')),
    [],
    'the probe files are removed',
  );
});

test('links are installed after files and a link never replaces a directory or is written through', t => {
  const f = fixture(t);
  const checkout = join(f.directory, 'checkout');
  // A State that bypassed parsing: the link `d` and a file below it.
  const files = [
    { path: 'd', mode: 'symlink', blob: f.blob(f.outside) },
    { path: 'd/x.txt', mode: 'file', blob: f.blob('inside') },
  ];
  const refused = /EEXIST|share one name on this volume/;
  assert.throws(() => installHostedCheckout(checkout, f.objects, files), refused);
  assert.deepEqual(readdirSync(f.outside), []);
  // On a volume that cannot tell the names apart the State is refused before anything is written.
  if (existsSync(join(checkout, 'd'))) {
    assert.equal(readFileSync(join(checkout, 'd/x.txt'), 'utf8'), 'inside');
    assert.equal(lstatSync(join(checkout, 'd')).isDirectory(), true);
  }

  // A well-formed State places links last and keeps them as links.
  const clean = join(f.directory, 'clean');
  installHostedCheckout(clean, f.objects, [
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
