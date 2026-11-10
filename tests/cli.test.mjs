// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fixture, write } from './helpers.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL(`../${manifest.bin.nforge}`, import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });

test('built CLI indexes a real worktree, queries, detects edits and re-indexes', t => {
  const root = fixture(t, { 'a.ts': 'export function greet() { return "hello"; }' });
  const indexed = run('index', root);
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.equal(JSON.parse(indexed.stdout).files, 1);
  const inspected = run('inspect', root, 'greet');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).results[0].name, 'greet');
  write(root, 'a.ts', 'export function goodbye() { return "bye"; }');
  const stale = run('inspect', root, 'greet');
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).error.code, 'SOURCE_STALE');
  assert.equal(run('index', root).status, 0);
  assert.equal(JSON.parse(run('inspect', root, 'goodbye').stdout).total, 1);
});

test('one client mode: a hosted checkout without Git metadata indexes and reads source locally', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-hosted-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    '.forge/hosted-main.json',
    JSON.stringify({ selection: { schema: 1, projectId: 'synthetic' } }),
  );
  write(root, 'a.ts', 'export function greet() { return "hello"; }');
  // An empty PATH proves no Git call: the old native owner was the only Git-free source.
  const env = { ...process.env, PATH: '' };
  const call = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 20_000 });
  const indexed = call('index', root);
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.equal(JSON.parse(indexed.stdout).files, 1, 'the hosted marker is not source');
  assert.equal(JSON.parse(indexed.stdout).gitHead, null);
  const source = call('source', root, 'a.ts', '1', '1');
  assert.equal(source.status, 0, source.stderr);
  assert.match(JSON.parse(source.stdout).results[0].text, /greet/);
});

test('CLI has useful help and structured argument errors', () => {
  assert.equal(run('--help').status, 0);
  for (const args of [
    ['index'],
    ['unknown', '.'],
    ['index', '.', '--limit', '2'],
    ['inspect', '.', 'x', '--limit', 'NaN'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'BAD_ARGUMENT');
  }
});
