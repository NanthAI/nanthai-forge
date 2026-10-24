// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { renameSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { indexRepository } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';
import { GraphQuery } from '../dist/graph-query.js';
import { fixture, write, code } from './helpers.mjs';

test('each public local query captures once, including initial construction and source/ref/impact checks', t => {
  const root = fixture(t, {
    'a.ts': 'export const value = 1;\n',
    'b.ts': 'import {value} from "./a.js"; export const result=value;\n',
  });
  indexRepository(root);
  const original = fs.openSync;
  let reads = 0;
  fs.openSync = function (path, ...args) {
    if (typeof path === 'string' && path.endsWith('/a.ts')) reads++;
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const query = new RepositoryQuery(root);
    assert.equal(reads, 0);
    for (const call of [
      () => query.status(),
      () => query.source('a.ts'),
      () => query.references('value'),
      () => query.impact('a.ts'),
      () => query.files(),
      () => query.declarations('a.ts'),
      () => query.context(),
      () => query.inspect('value'),
      () => query.imports('b.ts'),
    ]) {
      const before = reads;
      call();
      assert.equal(reads - before, 1);
    }
  } finally {
    fs.openSync = original;
    syncBuiltinESMExports();
  }
});
test('in-memory GraphQuery refresh boundary occurs once in each synchronous operation', t => {
  const root = fixture(t, { 'a.ts': 'export const value = 1;' }),
    { pack } = indexRepository(root);
  class CountingQuery extends GraphQuery {
    refresh() {
      this.calls = (this.calls ?? 0) + 1;
    }
  }
  const query = new CountingQuery(pack, {
    root,
    source: pack.source,
    content: new Map([['a.ts', 'export const value = 1;']]),
  });
  for (const call of [
    () => query.source('a.ts'),
    () => query.references('value'),
    () => query.impact('a.ts'),
  ]) {
    const before = query.calls ?? 0;
    call();
    assert.equal(query.calls - before, 1);
  }
});
test('queries never carry current freshness across requests or constructor-to-first-call edits', t => {
  const root = fixture(t, { 'a.ts': 'export const value = 1;' });
  indexRepository(root);
  const query = new RepositoryQuery(root);
  write(root, 'a.ts', 'export const value = 2;');
  assert.throws(() => query.source('a.ts'), code('SOURCE_STALE'));
  write(root, 'a.ts', 'export const value = 1;');
  assert.equal(query.source('a.ts').freshness, 'current');
  write(root, 'a.ts', 'export const value = 2;');
  assert.throws(() => query.references('value'), code('SOURCE_STALE'));
  assert.throws(() => query.impact('a.ts'), code('SOURCE_STALE'));
  assert.equal(query.status().freshness, 'stale');
});
test('renames, deletions, ignore changes and excluded source preserve the original freshness rules', t => {
  const root = fixture(t, {
    'a.ts': 'export const value=1;',
    '.gitignore': 'private.ts\n',
    'private.ts': 'export const privateValue=2;',
  });
  indexRepository(root);
  const query = new RepositoryQuery(root);
  write(root, 'private.ts', 'export const privateValue=3;');
  assert.equal(query.status().freshness, 'current');
  assert.throws(() => query.source('private.ts'), code('SOURCE_NOT_INDEXED'));
  write(root, '.gitignore', '');
  assert.throws(() => query.files(), code('SOURCE_STALE'));
  write(root, '.gitignore', 'private.ts\n');
  assert.equal(query.status().freshness, 'current');
  renameSync(join(root, 'a.ts'), join(root, 'b.ts'));
  assert.throws(() => query.source('a.ts'), code('SOURCE_STALE'));
  renameSync(join(root, 'b.ts'), join(root, 'a.ts'));
  assert.equal(query.source('a.ts').freshness, 'current');
  unlinkSync(join(root, 'a.ts'));
  assert.throws(() => query.inspect('value'), code('SOURCE_STALE'));
});
