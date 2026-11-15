// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { overlappingPaths, parseNativeStateValue } from '../dist/state/format.js';
import { safeRelative } from '../dist/safe-relative.js';

// Straightforward per-level overlap reference for the optimized path set.
const referenceOverlap = files => {
  const paths = new Set(files.map(file => file.path)),
    conflicts = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (paths.has(parent)) conflicts.add(parent);
    }
  }
  return [...conflicts].sort();
};

// Deterministic generator over separators, dot segments, reserved names and case/Unicode lookalikes.
const pieces = [
  'a',
  'b',
  '.',
  '..',
  '...',
  '',
  '/',
  '.git',
  '.GIT',
  '.Forge',
  'x.y',
  '\\',
  '\n',
  '\0',
  'İ',
  'ı',
  'ſ',
  ' ',
];
let seed = 20261105;
const next = limit => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
const generated = () =>
  Array.from({ length: next(6) }, () => pieces[next(pieces.length)]).join(next(3) ? '/' : '');

test('portable relative paths preserve Unicode and internal spaces while rejecting separators and aliases', () => {
  for (const path of ['a', 'a/b', 'a/.x', 'a/..x', '.a', 'a/x.y', 'İ/ı/ſ', 'a b/c'])
    assert.equal(safeRelative(path), true, JSON.stringify(path));
  for (const path of [
    'a//b',
    '/a',
    'a/',
    '.',
    '..',
    'a/./b',
    'a/../b',
    'a/...',
    '',
    'a.',
    'a /file',
    'dir/CON.txt',
    'x:stream',
    'x\\y',
    'x\n',
    'x\0',
  ])
    assert.equal(safeRelative(path), false, JSON.stringify(path));
});

test('overlappingPaths matches the per-level definition including empty and trailing segments', () => {
  assert.deepEqual(overlappingPaths([{ path: 'a' }, { path: 'a/b' }, { path: 'a/b/c' }]), ['a', 'a/b']);
  assert.deepEqual(overlappingPaths([{ path: 'a/b' }, { path: 'c/d' }]), []);
  for (let i = 0; i < 5_000; i++) {
    const files = Array.from({ length: next(8) }, () => ({ path: generated() }));
    assert.deepEqual(overlappingPaths(files), referenceOverlap(files), JSON.stringify(files));
  }
});

test('manifests reject reserved .forge and .git segments in any case and accept lookalike names', () => {
  const blob = 'a'.repeat(64);
  const parse = path =>
    parseNativeStateValue({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [{ path, blob, mode: 'file' }],
      message: 'm',
      at: '2026-01-01T00:00:00.000Z',
    });
  for (const path of ['.git', '.GIT/config', 'a/.Forge', 'a/.fOrGe/b', 'x/.git'])
    assert.throws(() => parse(path), { code: 'INVALID_NATIVE_SOURCE' }, path);
  for (const path of ['.gitignore', 'x.git/y', 'a/.github/ci.yml', '.forgery', 'git/.gi'])
    assert.equal(parse(path).files.length, 1, path);
});
