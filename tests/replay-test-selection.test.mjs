// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainedDurations, replaySelection } from '../scripts/replay-test-selection.mjs';

test('timing replay accepts complete selected-file reports only, including prefixed lines', () => {
  const row = patch =>
    `__FORGE_TESTS__${JSON.stringify({ file: 'tests/a.test.mjs', complete: true, durationMs: 100, ...patch })}`;
  const reports = [
    row({}),
    `prefix ${row({ durationMs: 200 })}`,
    row({ file: 'tests/other.test.mjs' }),
    row({ complete: false }),
    row({ durationMs: -1 }),
    '__FORGE_TESTS__{',
  ];
  assert.deepEqual(retainedDurations(reports.join('\n'), ['tests/a.test.mjs']), { 'tests/a.test.mjs': 200 });
});

test('read-only replay distinguishes literal imports, runtime paths and fail-closed timing estimates', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-selection-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) =>
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  mkdirSync(join(root, 'modal-source'));
  for (const dir of ['src', 'web', 'convex', 'netlify', 'tests', 'scripts'])
    mkdirSync(join(root, 'modal-source', dir));
  put('modal-source/package.json', { scripts: {} });
  put('modal-source/package-lock.json', { packages: {} });
  put('modal-source/src/a.ts', 'export const a=1');
  put('modal-source/src/b.ts', 'export const b=1');
  put('modal-source/tests/a.test.mjs', "import '../dist/a.js'");
  put('modal-source/tests/b.test.mjs', "import '../dist/b.js'");
  put('changes.json', {
    version: 1,
    comparison: 'main',
    base: 'a'.repeat(64),
    head: 'b'.repeat(64),
    paths: ['src/a.ts'],
  });
  const tests = ['tests/a.test.mjs', 'tests/b.test.mjs'];
  put('selection.json', { scope: 'scoped', tests });
  put('modal-plan.json', { groups: [tests] });
  put(
    'stdout.log',
    tests
      .map(file => `__FORGE_TESTS__${JSON.stringify({ file, complete: true, durationMs: 60000 })}`)
      .join('\n'),
  );
  const result = replaySelection(root);
  assert.equal(result.before, 2);
  assert.equal(result.after, 1);
  assert.equal(result.staticImportConsumers, 1);
  assert.equal(result.literalRuntimeConsumers, 1);
  assert.deepEqual(result.removed, ['tests/b.test.mjs']);
  assert.equal(result.estimatedShardMinutes.missingTimingFiles, 0);
  assert.equal(result.estimatedShardMinutes.saved, 0); // Two simultaneous files used one worker-minute.
  assert.equal(result.selection.reasons['tests/a.test.mjs'].kind, 'dependency');
  put('changes.json', {
    version: 1,
    comparison: 'main',
    base: 'a'.repeat(64),
    head: 'b'.repeat(64),
    paths: ['package.json'],
  });
  assert.equal(replaySelection(root).scope, 'full');
});
