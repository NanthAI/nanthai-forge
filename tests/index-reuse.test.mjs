// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { statSync, utimesSync, renameSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexRepository, capture, analyze } from '../dist/index.js';
import { Workspace } from '../dist/workspace.js';
import { RepositoryQuery } from '../dist/query.js';
import { fixture, write, code } from './helpers.mjs';

const files = {
  'a.ts': 'export const value = 1; export function read() { return value; }',
  'b.ts': 'import {value} from "./a.js"; export const use = value;',
  'c.ts': 'export {use} from "./b.js";',
  'unused.ts': 'export const unused = 2;',
};

test('unchanged indexing retains both byte captures, reuses the exact graph and does not rewrite the artifact', t => {
  const root = fixture(t, files),
    session = {},
    first = indexRepository(root, undefined, session);
  const path = join(root, '.forge/index.json'),
    before = statSync(path),
    bytes = readFileSync(path);
  const next = indexRepository(root, undefined, session);
  assert.deepEqual(next.pack, first.pack);
  assert.equal(
    first.pack.analysis.version,
    'typescript@5.9.3;@lezer/python@1.1.19;@lezer/java@1.1.5;@lezer/rust@1.0.3',
  );
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.equal(next.work.reusedArtifact, true);
  assert.equal(next.work.sourceCaptures, 2);
  assert.equal(next.work.capturedFiles, 8);
  assert.equal(next.work.parsedFiles, 0);
  assert.equal(next.work.analyzedFiles, 0);
});

test('incremental syntax reuse equals cold semantic analysis across edits, renames, deletions, syntax and ignore changes', t => {
  const root = fixture(t, {
      ...files,
      '.gitignore': 'ignored.ts\n',
      'ignored.ts': 'export const privateName = 1;',
    }),
    session = {};
  indexRepository(root, undefined, session);
  const compare = () => {
    const next = indexRepository(root, undefined, session);
    assert.deepEqual(next.pack, analyze(capture(root)));
    return next;
  };
  const path = join(root, 'a.ts'),
    time = statSync(path);
  write(root, 'a.ts', 'export const value = 9; export function read() { return value; }');
  utimesSync(path, time.atime, time.mtime);
  assert.equal(new RepositoryQuery(root).status().freshness, 'stale');
  const edited = compare();
  assert.equal(edited.work.parsedFiles, 1);
  assert.equal(edited.work.reusedSyntaxFiles, 3);
  write(root, 'a.ts', 'export const renamed = 9;');
  compare();
  renameSync(join(root, 'a.ts'), join(root, 'renamed.ts'));
  compare();
  write(root, 'b.ts', 'import {renamed} from "./renamed.js"; export const use = renamed;');
  compare();
  unlinkSync(join(root, 'renamed.ts'));
  compare();
  write(root, 'renamed.ts', 'export const renamed = ;');
  compare();
  write(root, 'renamed.ts', 'export const renamed = 10;');
  compare();
  write(root, '.gitignore', '');
  compare();
  write(root, '.gitignore', 'ignored.ts\n');
  compare();
  write(root, 'unsupported.txt', 'New excluded file changes coverage counts');
  assert.equal(compare().work.reusedArtifact, false);
  assert.equal(new RepositoryQuery(root).status().freshness, 'current');
});

test('compiler reuse never crosses selected roots and artifact provenance changes require fresh analysis', t => {
  const left = fixture(t, files),
    right = fixture(t, files),
    session = {};
  indexRepository(left, undefined, session);
  const different = indexRepository(right, undefined, session);
  assert.equal(different.work.reusedSyntaxFiles, 0);
  assert.equal(different.work.parsedFiles, 4);
  const path = join(right, '.forge/index.json'),
    raw = JSON.parse(readFileSync(path));
  // An invalid graph is rebuilt, never trusted merely because its source ID matches.
  raw.analysis.version = 'unknown';
  writeFileSync(path, JSON.stringify(raw));
  const rebuilt = indexRepository(right, undefined, session);
  assert.equal(rebuilt.work.reusedArtifact, false);
  assert.deepEqual(rebuilt.pack, analyze(capture(right)));
});

test('Workspace retains one compiler, coalesces requests, recovers after failure and worker exit, and closes', async t => {
  const root = fixture(t, files),
    workspace = new Workspace(root);
  t.after(() => workspace.close());
  const first = workspace.reindex();
  assert.equal(workspace.reindex(), first);
  await first;
  const originalWorker = workspace.worker;
  write(root, 'a.ts', 'export const value = 3;');
  const changed = await workspace.reindex();
  assert.equal(workspace.worker, originalWorker);
  assert.equal(changed.work.parsedFiles, 1);
  assert.equal(changed.work.reusedSyntaxFiles, 3);
  const original = readFileSync(join(root, '.forge/index.json'));
  writeFileSync(join(root, 'a.ts'), Buffer.from([0xff]));
  await assert.rejects(workspace.reindex(), code('INVALID_ENCODING'));
  assert.equal(workspace.worker, undefined);
  assert.deepEqual(readFileSync(join(root, '.forge/index.json')), original);
  write(root, 'a.ts', 'export const value = 4;');
  await workspace.reindex();
  assert.notEqual(workspace.worker, originalWorker);
  await workspace.worker.terminate();
  assert.equal(workspace.worker, undefined);
  await workspace.reindex();
  await workspace.close();
  await assert.rejects(workspace.reindex(), code('WORKSPACE_CLOSED'));
});

test('an idle indexing worker does not keep a CLI process alive', t => {
  const root = fixture(t, files),
    module = new URL('../dist/workspace.js', import.meta.url).href;
  const script = join(root, 'idle-index-client.mjs');
  writeFileSync(
    script,
    `const {Workspace}=await import(${JSON.stringify(module)});await new Workspace(${JSON.stringify(root)}).reindex();console.log('finished');`,
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /finished/);
});

test('idle compiler eviction bounds retained workers without restricting repositories or active work', async t => {
  const spaces = Array.from({ length: 3 }, () => new Workspace(fixture(t, files)));
  t.after(() => Promise.all(spaces.map(space => space.close())));
  await spaces[0].reindex();
  await spaces[1].reindex();
  await spaces[2].reindex();
  assert.equal(spaces[0].worker, undefined);
  assert.ok(spaces[1].worker);
  assert.ok(spaces[2].worker);
  assert.equal((await spaces[0].reindex()).work.reusedArtifact, true);
  assert.equal(spaces[1].worker, undefined);
  assert.equal(spaces[0].query().status().freshness, 'current');
});

test('unchanged graph reuse still detects edits between the two byte captures', t => {
  const root = fixture(t, files);
  indexRepository(root);
  const artifact = readFileSync(join(root, '.forge/index.json')),
    open = fs.openSync;
  let reads = 0;
  fs.openSync = function (path, ...args) {
    if (typeof path === 'string' && path.endsWith('/a.ts') && ++reads === 2)
      write(root, 'a.ts', 'export const changed = 1;');
    return open.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => indexRepository(root), code('SOURCE_CHANGED'));
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readFileSync(join(root, '.forge/index.json')), artifact);
});
