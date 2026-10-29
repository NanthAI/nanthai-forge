// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { modalPlan } from '../dist/modal-plan.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { benchmarkPlan } from '../scripts/bench-landing-shard.mjs';
import { smokeTests, selectionSourcePath } from '../scripts/test-impact.mjs';

function fixture(t, extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'forge-e3-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  initNative(root);
  const source = new NativeSource(root);
  const files = new Map([
    ['package.json', '{"type":"module","scripts":{}}'],
    ['package-lock.json', '{"packages":{}}'],
    ['scripts/forge-check.mjs', '// Synthetic standard command'],
    // E3's installed selector treated this process-path predicate as a read of
    // every core module, then pulled in every test importing the cleanup helper.
    [
      'tests/owner-cleanup.mjs',
      `import { resolve } from 'node:path';
      function ownerWorkers(roots, _workerDirectory) { return roots.length; }
      export function cleanup(workerDirectory = resolve('dist')) {
        return ownerWorkers([], workerDirectory);
      }`,
    ],
    ['tests/landing-batch-fixture.mjs', "export { cleanup } from './owner-cleanup.mjs';"],
    ...Array.from({ length: 12 }, (_, index) => [
      `tests/unrelated-${index}.test.mjs`,
      "import './landing-batch-fixture.mjs';",
    ]),
    ...smokeTests.map(path => [path, '// Synthetic fixed smoke']),
    ...extra,
  ]);
  const snapshot = (files, parents = []) =>
    source.writeState(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, text]) => ({
          path,
          blob: source.put(Buffer.from(text)),
          mode: 'file',
        })),
      parents,
      'Synthetic E3 selection',
      new Date().toISOString(),
    );
  const base = snapshot(files);
  const data = { views: [], landingEntries: [], landingBatches: [], channelMoves: [] };
  const store = {
    native: true,
    root,
    directory: join(root, '.forge', 'work'),
    load: () => data,
    readRecords: () => null,
  };
  const changes = Array.from(
    { length: 4 },
    (_, index) =>
      new Map([
        [`src/bench-probe-burst-${index}.ts`, `export const token = 'member-${index}';`],
        [
          `tests/bench-probe-burst-${index}.test.mjs`,
          `import test from 'node:test';
      import assert from 'node:assert/strict';
      import { token } from '../dist/bench-probe-burst-${index}.js';
      test('probe ${index}', () => assert.equal(token, 'member-${index}${index === 1 ? '-E3-deliberate-failure' : ''}'));`,
        ],
      ]),
  );
  for (const [index, change] of changes.entries()) {
    const head = snapshot(new Map([...files, ...change]), [base]);
    const viewId = `entry-view-${index}`;
    data.views.push({ id: viewId, base, composedMain: base, head });
    data.landingEntries.push({ id: `entry-${index}`, viewId });
  }
  let serial = 0;
  async function plan(members, extra = []) {
    const combined = new Map([...files, ...members.flatMap(index => [...changes[index]]), ...extra]);
    const head = snapshot(combined, [base]);
    const viewId = `batch-view-${serial++}`;
    data.landingBatches.push({ prefixes: [{ viewId, entryIds: members.map(index => `entry-${index}`) }] });
    const directory = join(store.directory, viewId);
    mkdirSync(directory);
    const run = {
      id: viewId,
      viewId,
      base,
      comparisonBase: base,
      head,
      check: { executable: process.execPath, args: ['scripts/forge-check.mjs'], definition: 'a'.repeat(64) },
      environment: { env: { FORGE_CHECK_SCOPED: '1' } },
    };
    const forge = await modalPlan(store, run, directory, 4);
    const comparison = JSON.parse(readFileSync(join(directory, 'changes.json'), 'utf8'));
    const inventory = new Map([...combined].filter(([path]) => selectionSourcePath(path)));
    const github = benchmarkPlan(4, comparison, inventory, {});
    assert.deepEqual(forge.selection, github.selection);
    assert.deepEqual(forge.groups, github.groups);
    assert.deepEqual(
      comparison.paths,
      [
        ...new Set([...members.flatMap(index => [...changes[index].keys()]), ...extra.map(([path]) => path)]),
      ].sort(),
    );
    return forge;
  }
  return { plan, changes };
}

test('E3 burst and diagnosis prefixes select the union of entry tests against the batch base', async t => {
  const previous = process.env;
  process.env = { ...previous, FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '0', FORGE_CHECK_INTERACTION: '0' };
  t.after(() => {
    process.env = previous;
  });
  const { plan, changes } = fixture(t);
  const entries = await Promise.all([0, 1, 2, 3].map(index => plan([index])));
  for (const entry of entries) assert.equal(entry.selection.tests.length, smokeTests.length + 1);
  const batch = await plan([0, 1, 2, 3]);
  for (const members of [[0, 1, 2, 3], [0], [0, 1], [0, 1, 2], [0, 2, 3]]) {
    const selected = members.length === 4 ? batch : await plan(members);
    const expected = [...new Set(members.flatMap(index => entries[index].selection.tests))].sort();
    assert.equal(selected.selection.scope, 'scoped');
    assert.deepEqual(selected.selection.tests, expected);
    assert.equal(selected.selection.tests.length, smokeTests.length + members.length);
    assert.deepEqual([...selected.groups.flat()].sort(), expected);
    assert.ok(!selected.selection.tests.some(path => path.includes('unrelated-')));
  }
  // Execute only the four tiny probes, never a broad planner-selected suite.
  mkdirSync(join(batch.source, 'dist'));
  for (const change of changes)
    for (const [path, text] of change)
      if (path.startsWith('src/'))
        writeFileSync(join(batch.source, path.replace('src/', 'dist/').replace('.ts', '.js')), text);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/check-runtime.mjs',
      '--test',
      '--test-concurrency=2',
      '--test-reporter=tap',
      ...changes.map(change =>
        join(
          batch.source,
          [...change.keys()].find(path => path.startsWith('tests/')),
        ),
      ),
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /# tests 4\b/);
  assert.match(result.stdout, /# pass 3\b/);
  assert.match(result.stdout, /# fail 1\b/);
  assert.match(result.stdout, /not ok \d+ - probe 1/);
});

test('conservative landing fallbacks retain their triggering path in the check selection', async t => {
  const previous = process.env;
  process.env = { ...previous, FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '0', FORGE_CHECK_INTERACTION: '0' };
  t.after(() => {
    process.env = previous;
  });
  for (const lock of ['{', '{"packages":{"node_modules/local":{"link":true}}}']) {
    const { plan } = fixture(t, [['package-lock.json', lock]]);
    const selected = await plan([0, 1, 2, 3]);
    assert.equal(selected.selection.scope, 'full');
    assert.match(selected.selection.reason, /package-lock\.json/);
  }
});
