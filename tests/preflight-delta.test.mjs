// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, runPreflight } from '../dist/agent-preflight.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { deltaPaths, savedInventory } from '../dist/agent-preflight-evidence.js';
const laneId = '11111111-1111-4111-8111-111111111111';
function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-delta-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = new Map([
    ['package.json', '{"type":"module","scripts":{}}'],
    ['src/a.ts', `export const n = ${fail ? 0 : 1};`],
    ['src/b.ts', 'export const n = 1;'],
    [
      'tests/a.test.mjs',
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {n} from '../src/a.ts'; test('a', () => assert.equal(n,1));",
    ],
    ['tests/b.test.mjs', "import test from 'node:test'; import {n} from '../src/b.ts'; test('b', () => n);"],
  ]);
  const put = (path, body) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
    bytes.set(path, body);
  };
  for (const [path, body] of bytes) put(path, body);
  const files = () => [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = (extraPaths = []) =>
    preflightPlan(
      root,
      { paths: ['src/a.ts', 'src/b.ts', ...extraPaths], complete: true },
      { laneId, files: files() },
    );
  const run = p => runPreflight(root, laneId, digest(JSON.stringify(files())), p, sourceTree(files()));
  return { root, files, bytes, put, plan, run };
}
test('a small saved delta reruns its consumers and reuses passes for the unchanged tree', t => {
  const f = fixture(t);
  const initial = f.plan();
  assert.deepEqual(initial.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const firstReceipt = f.run(initial);
  assert.equal(firstReceipt.passed, true);
  f.put('src/a.ts', 'export const n = 1; // small correction');
  const delta = f.plan();
  assert.deepEqual(delta.deltaPaths, ['src/a.ts']);
  assert.equal(delta.reusedFrom.tree, firstReceipt.tree);
  assert.equal(delta.reusedFrom.evidence, firstReceipt.evidence);
  assert.deepEqual(delta.tests, ['tests/a.test.mjs']);
  assert.deepEqual(delta.reusedTests, ['tests/b.test.mjs']);
  const result = f.run(delta);
  assert.equal(result.passed, true);
  assert.equal(result.tests, 1);
  assert.equal(result.reusedTests, 1);
  const unchanged = f.plan();
  assert.deepEqual(unchanged.tests, []);
  assert.deepEqual(unchanged.reusedTests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
});
test('an added regression test runs without invalidating unrelated prior passes', t => {
  const f = fixture(t);
  assert.equal(f.run(f.plan()).passed, true);
  f.put('tests/new.test.mjs', "import test from 'node:test'; test('new', () => {});");
  const delta = f.plan(['tests/new.test.mjs']);
  assert.deepEqual(delta.tests, ['tests/new.test.mjs']);
  assert.deepEqual(delta.reusedTests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(f.run(delta).passed, true);
});
test('a failed run retains passing files; failed and newly affected files must execute', t => {
  const f = fixture(t, true);
  assert.equal(f.run(f.plan()).passed, false);
  const retry = f.plan();
  assert.deepEqual(retry.tests, ['tests/a.test.mjs']);
  assert.deepEqual(retry.reusedTests, ['tests/b.test.mjs']);
  f.put('src/a.ts', 'export const n = 1;');
  const corrected = f.plan();
  assert.deepEqual(corrected.tests, ['tests/a.test.mjs']);
  assert.deepEqual(corrected.reusedTests, ['tests/b.test.mjs']);
  assert.equal(f.run(corrected).passed, true);
});
test('the old graph still invalidates consumers when a dependency edge is removed', t => {
  const f = fixture(t);
  f.put('src/b.ts', "import './a.ts'; export const n = 1;");
  assert.equal(f.run(f.plan()).passed, true);
  f.put('src/b.ts', 'export const n = 1;');
  f.put('src/a.ts', 'export const n = 1; // changed');
  const delta = f.plan();
  assert.deepEqual(delta.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(delta.reusedTests, []);
});
test('missing/tampered evidence and root configuration changes never transfer a pass', t => {
  const f = fixture(t);
  const result = f.run(f.plan());
  f.put('package.json', '{"type":"module","scripts":{},"config":1}');
  const config = f.plan();
  assert.deepEqual(config.reusedTests, []);
  // Full coverage is explicitly deferred to landing; it is never a reused local pass.
  assert.deepEqual(config.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const evidence = join(clientCacheRoot(f.root), 'agent/preflight/evidence', `${result.evidence}.gz`);
  writeFileSync(evidence, 'corrupt');
  const fallback = f.plan();
  assert.deepEqual(fallback.reusedTests, []);
  assert.deepEqual(fallback.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const receiptPath = join(clientCacheRoot(f.root), 'agent/preflight', `${laneId}.json`);
  const old = JSON.parse(readFileSync(receiptPath, 'utf8'));
  delete old.evidence;
  writeFileSync(receiptPath, JSON.stringify(old));
  assert.deepEqual(f.plan().reusedTests, []);
});
test('delta identity includes addition, deletion and mode changes; unavailable base paths stay unavailable', t => {
  const f = fixture(t);
  const before = f.files();
  const after = before
    .filter(file => file.path !== 'src/a.ts')
    .map(file => (file.path === 'src/b.ts' ? { ...file, mode: 'executable' } : file));
  after.push({ path: 'src/new.ts', blob: digest('new'), mode: 'file' });
  assert.deepEqual(deltaPaths(before, after), ['src/a.ts', 'src/b.ts', 'src/new.ts']);
  assert.equal(
    preflightPlan(f.root, { paths: [], complete: false }, { laneId, files: after }).status,
    'unavailable',
  );
});

test('a receipt labels deferred full coverage as local execution', t => {
  const f = fixture(t);
  const receipt = f.run({
    status: 'planned',
    scope: 'full',
    tests: [],
    deferredTests: ['tests/a.test.mjs', 'tests/b.test.mjs'],
    estimateMinutes: 0,
    command: null,
  });
  assert.equal(receipt.selection, 'local');
  assert.equal(receipt.tests, 0);
  assert.equal(receipt.deferredTests, 2);
});

test('a sparse selector inventory defers unseen consumers and never reuses partial source evidence', t => {
  const f = fixture(t);
  assert.equal(savedInventory(f.files(), new Map(f.bytes)), true);
  const partial = new Map(f.bytes);
  partial.delete('tests/b.test.mjs');
  assert.equal(savedInventory(f.files(), partial), false);
  rmSync(join(f.root, 'tests/b.test.mjs'));
  const plan = f.plan();
  assert.equal(plan.scope, 'full');
  assert.ok(plan.deferredTests.includes('tests/b.test.mjs'));
  assert.deepEqual(plan.reusedTests, []);
});
