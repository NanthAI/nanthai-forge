// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleInventory, moduleFindings } from '../scripts/agent-weight-modules.mjs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('weight diagnostics show added and retired chunks without private roots or hash churn', () => {
  const root = resolve('synthetic'),
    url = path => pathToFileURL(join(root, path)).href;
  const prior = moduleInventory(
    [url('dist/cli-bundle-read-abc12345.js'), url('dist/cli-bundle-retired-abc12345.js'), 'node:fs'],
    root,
  );
  const current = moduleInventory(
    [
      url('dist/cli-bundle-read-def67890.js'),
      url('dist/cli-bundle-extra-xyz12345.js'),
      url('node_modules/pkg/index.js'),
    ],
    root,
  );
  assert.deepEqual(prior, ['dist/cli-bundle-read-HASH.js', 'dist/cli-bundle-retired-HASH.js']);
  assert.deepEqual(
    moduleFindings(
      { moduleInventory: { status: current } },
      { report: { moduleInventory: { status: prior } } },
    ),
    [
      'status: added modules/chunks: dist/cli-bundle-extra-HASH.js, node_modules/pkg/index.js',
      'status: removed modules/chunks: dist/cli-bundle-retired-HASH.js',
    ],
  );
  assert.deepEqual(
    moduleFindings(
      { moduleInventory: { status: prior } },
      { report: { moduleInventory: { status: prior } } },
    ),
    [],
  );
  assert.match(
    moduleFindings({ moduleInventory: { status: prior } }, {})[0],
    /reference inventory unavailable.*cli-bundle-read-HASH/,
  );
});

test('ordinary eight-letter module names stay distinct from generated chunk hashes', () => {
  const root = resolve('synthetic'),
    url = path => pathToFileURL(join(root, path)).href;
  const prior = moduleInventory([url('dist/cli-rollback.js')], root);
  const current = moduleInventory(
    [
      url('dist/cli-rollback.js'),
      url('dist/cli-recovery.js'),
      'file:///C:/cache/node_modules/pkg/cli-rollback.js',
    ],
    root,
  );
  assert.deepEqual(current, [
    'dist/cli-recovery.js',
    'dist/cli-rollback.js',
    'node_modules/pkg/cli-rollback.js',
  ]);
  assert.deepEqual(
    moduleFindings(
      { moduleInventory: { status: current } },
      { report: { moduleInventory: { status: prior } } },
    ),
    ['status: added modules/chunks: dist/cli-recovery.js, node_modules/pkg/cli-rollback.js'],
  );
});

test('large MCP-sized module inventories are complete even when stderr cannot hold the URLs at exit', async t => {
  const { temporaryDirectory } = await import('../scripts/test-temp.mjs');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = temporaryDirectory(t, 'forge-module-inventory-');
  const names = Array.from({ length: 1000 }, (_, index) => `synthetic-module-${index}.mjs`);
  for (const name of names) writeFileSync(join(root, name), 'export {};\n');
  const entry = join(root, 'entry.mjs'),
    output = join(root, 'modules.json');
  writeFileSync(entry, names.map(name => `import './${name}';`).join('\n'));
  const child = spawnSync(
    process.execPath,
    ['--import', new URL('../scripts/perf/startup-preload.mjs', import.meta.url).pathname, entry],
    {
      env: { ...process.env, FORGE_PROBE_MODULES_FILE: output },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(/FORGE_STARTUP (\{.*\})/.exec(child.stderr)[1]);
  assert.equal(report.modules, 1001);
  assert.equal(JSON.parse(readFileSync(output)).length, 1001);
  assert(!child.stderr.includes('synthetic-module-'), 'URLs stay in the private inventory file');
});

test('ad80e037: a module added to every command is named once, before the counts, with the commands that load it', () => {
  const reference = { report: { moduleInventory: { version: ['a.js'], help: ['a.js'], status: ['a.js'] } } };
  const report = {
    moduleInventory: {
      version: ['a.js', 'new.js'],
      help: ['a.js', 'new.js'],
      status: ['a.js', 'new.js', 'own.js'],
    },
  };
  assert.deepEqual(moduleFindings(report, reference), [
    'version, help, status: added modules/chunks: new.js',
    'status: added modules/chunks: own.js',
  ]);
});
