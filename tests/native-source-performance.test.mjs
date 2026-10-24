// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource, nativePaths } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-source-performance-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('capture retained-path lookup does linear work for a flat tracked tree', t => {
  const root = fixture(t),
    retained = Array.from({ length: 1000 }, (_, i) => `f${i}.txt`);
  for (const path of retained) writeFileSync(join(root, path), '');
  let visits = 0;
  const iterator = retained[Symbol.iterator].bind(retained);
  retained[Symbol.iterator] = function* () {
    for (const path of iterator()) {
      visits++;
      yield path;
    }
  };
  // Count the old array scans as well as the one-time Set construction.
  retained.some = predicate =>
    Array.prototype.some.call(retained, (...args) => {
      visits++;
      return predicate(...args);
    });
  retained.includes = path => {
    for (let i = 0; i < retained.length; i++) {
      visits++;
      if (retained[i] === path) return true;
    }
    return false;
  };
  assert.deepEqual(nativePaths(root, retained), [...retained].sort());
  assert(visits <= retained.length * 3, `retained path visits: ${visits}`);
});

test('retained files and directory prefixes preserve ignore and exclusion coverage', t => {
  const root = fixture(t);
  const files = [
    '.gitignore',
    'visible.txt',
    'ignored/deep/keep.txt',
    'ignored/deep/drop.txt',
    'dist/deep/keep.txt',
    'dist/deep/drop.txt',
    '.env',
    'other.scratch',
    'keep.scratch',
  ];
  for (const path of files) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path === '.gitignore' ? 'ignored/\n*.scratch\n' : 'synthetic');
  }
  const excluded = [];
  assert.deepEqual(
    nativePaths(root, ['ignored/deep/keep.txt', 'dist/deep/keep.txt', 'keep.scratch'], excluded),
    ['.gitignore', 'dist/deep/keep.txt', 'ignored/deep/keep.txt', 'keep.scratch', 'visible.txt'],
  );
  assert.deepEqual(excluded, [
    { path: '.env', reason: 'sensitive-name' },
    { path: 'dist/deep/drop.txt', reason: 'protected-directory' },
    { path: 'ignored/deep/drop.txt', reason: 'gitignored' },
    { path: 'other.scratch', reason: 'gitignored' },
  ]);
});

function history(t) {
  const source = new NativeSource(fixture(t)),
    objects = new Map(),
    reads = new Map();
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `src/f${i}.ts`,
    blob: 'a'.repeat(64),
    mode: 'file',
  }));
  const state = (message, parents = []) => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        files,
        parents,
        message,
        at: '2026-10-15T00:00:00.000Z',
      }),
    );
    const id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  source.object = id => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    assert(objects.has(id), 'unexpected State read');
    return objects.get(id);
  };
  const chain = [state('root')];
  for (let i = 1; i < 40; i++) chain.push(state(`state ${i}`, [chain.at(-1)]));
  return { source, objects, reads, chain, state };
}

test('contains stops at the verified match, handles both merge parents and negative ancestry', t => {
  const { source, reads, chain, state } = history(t);
  assert.equal(source.contains(chain[39], chain[38]), true);
  assert.deepEqual([...reads.keys()], [chain[39], chain[38]]);
  reads.clear();
  assert.equal(source.contains(chain[39], chain[39]), true);
  assert.deepEqual([...reads.keys()], [chain[39]]);
  const side = state('side', [chain[10]]),
    merge = state('merge', [chain[39], side]);
  assert.equal(source.contains(merge, chain[39]), true);
  assert.equal(source.contains(merge, side), true);
  assert.equal(source.contains(side, chain[39]), false);
  assert.equal(source.contains(chain[0], side), false);
});

test('one ancestry operation verifies shared States once; later operations read them afresh', t => {
  const { source, reads, chain, state, objects } = history(t);
  const side = state('side', [chain[20]]),
    ancestry = source.ancestry();
  assert.equal(ancestry.contains(chain[39], chain[30]), true);
  assert.equal(ancestry.contains(chain[39], chain[20]), true);
  assert.equal(ancestry.contains(side, chain[10]), true);
  assert.equal(ancestry.ancestors(chain[39]).size, 40);
  assert.equal(ancestry.ancestors(side).size, 22);
  assert([...reads.values()].every(count => count === 1));
  objects.set(chain[39], Buffer.from('{}'));
  assert.throws(() => source.contains(chain[39], chain[39]));
  assert.equal(reads.get(chain[39]), 2);
});

test('compose fast-forwards without reading earlier history and shares verification for divergent heads', t => {
  const { source, reads, chain, state } = history(t);
  assert.deepEqual(source.compose(chain[39], chain[38], 'merge', 'now'), { head: chain[39], conflicts: [] });
  assert.deepEqual([...reads.keys()], [chain[39], chain[38]]);
  reads.clear();
  const side = state('side', [chain[20]]);
  // Stop before writing a merged State: inspect traversal work at the merge boundary.
  source.mergeFiles = (_left, _right, a, b, ancestry) => {
    assert.equal(a.size, 40);
    assert.equal(b.size, 22);
    for (const id of a) ancestry.parents(id);
    assert([...reads.values()].every(count => count === 1));
    return { files: [], conflicts: [{ path: 'synthetic-conflict' }] };
  };
  assert.deepEqual(source.compose(chain[39], side, 'merge', 'now'), { conflicts: ['synthetic-conflict'] });
});

test('early-exit queries still reject missing and tampered visited States', t => {
  const source = new NativeSource(fixture(t));
  const root = source.writeState([], [], 'root', '2026-10-15T00:00:00.000Z');
  const head = source.writeState([], [root], 'head', '2026-10-15T00:00:00.000Z');
  assert.equal(source.contains(head, root), true);
  writeFileSync(join(source.directory, head), 'tampered');
  assert.throws(
    () => source.contains(head, head),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.throws(
    () => source.contains('f'.repeat(64), root),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});
