// SPDX-License-Identifier: Apache-2.0
// Friction c804f164: a focused `node --test` run left out the project's test preload and failed only
// on that machine. Heavy names the preloads the project's own test script passes (synthetic projects).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingTestPreloads, preloadNotice } from '../dist/heavy-test-preloads.js';

const project = (t, manifest) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-heavy-preload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (manifest !== undefined) writeFileSync(join(root, 'package.json'), manifest);
  return root;
};
const script = test => JSON.stringify({ scripts: { test } });

test('names each preload of the test script that the command leaves out', t => {
  const root = project(
    t,
    script('npm run build && node --import ./setup.mjs -r ./env.cjs --test tests/*.test.mjs'),
  );
  assert.deepEqual(missingTestPreloads(['node', '--test', 'tests/a.test.mjs'], root), [
    '--import ./setup.mjs',
    '--require ./env.cjs',
  ]);
  // Either spelling of the same preload counts as present.
  assert.deepEqual(
    missingTestPreloads(
      ['node', '--import=./setup.mjs', '--require', './env.cjs', '--test', 'tests/a.test.mjs'],
      root,
    ),
    [],
  );
  assert.match(preloadNotice(['--import ./setup.mjs']), /Add --import \.\/setup\.mjs before --test/);
});

test('asks for nothing without a node --test script or a readable manifest', t => {
  for (const manifest of [
    undefined,
    'not json',
    JSON.stringify({ scripts: {} }),
    script('vitest run'),
    script('node --import ./setup.mjs scripts/run.mjs'),
    script('node --test tests/*.test.mjs'),
  ])
    assert.deepEqual(
      missingTestPreloads(['node', '--test', 'tests/a.test.mjs'], project(t, manifest)),
      [],
      String(manifest),
    );
});
