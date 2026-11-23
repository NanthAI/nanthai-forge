// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { selectStaticChecks, staticChecks } from '../dist/agent-preflight-static.js';
import { agentCeilingFindings } from '../scripts/agent-weight-modules.mjs';
import { baselineHash, readWeightBaseline } from '../scripts/agent-weight.mjs';
import { packageProbeProcesses } from '../scripts/package-probe-process.mjs';
import { cacheInstalledBytes, packageInstalledBytes } from '../scripts/package-installed-bytes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestText = readFileSync(join(root, 'package.json'), 'utf8');
const ceilingCheck = staticChecks(manifestText).find(check =>
  check.command.includes('scripts/package-ceilings.mjs'),
);

test('package ceilings select shipped paths and build inputs, and cost nothing on unrelated changes', () => {
  assert.ok(ceilingCheck);
  for (const input of [
    'src/mcp-agent-workflow.ts',
    'scripts/test-import-graph.mjs',
    'scripts/build-cli-bundle.mjs',
    'scripts/prepare-convex-api.mjs',
    'scripts/control-browser-cache.d.mts',
    'docs/concepts.md',
    'README.md',
    'web/src/assets/NOTICE.md',
    'package-lock.json',
  ])
    assert.deepEqual(selectStaticChecks([ceilingCheck], [input]).selected, [ceilingCheck], input);
  for (const input of ['tests/ordinary.test.mjs', 'web/src/page.tsx', 'convex/schema.ts', 'AGENTS.md'])
    assert.deepEqual(selectStaticChecks([ceilingCheck], [input]).selected, [], input);
});

test('installed-byte evidence is exact only for the package inputs smoke measured', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-package-bytes-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'lane');
  mkdirSync(root);
  const manifest = { files: ['README.md', 'scripts/runtime.mjs'] };
  mkdirSync(join(root, 'scripts'));
  for (const path of [
    'agent-weight.mjs',
    'package-local.mjs',
    'package-notices.mjs',
    'package-npm.mjs',
    'package-smoke.mjs',
  ])
    writeFileSync(join(root, 'scripts', path), '');
  writeFileSync(join(root, 'README.md'), 'v1');
  writeFileSync(join(root, 'package-lock.json'), 'lock');
  writeFileSync(join(root, 'scripts/runtime.mjs'), 'runtime');
  const npm = join(root, 'synthetic-npm.mjs');
  const userconfig = join(root, 'synthetic.npmrc');
  writeFileSync(npm, '// synthetic npm executable');
  writeFileSync(userconfig, 'install-strategy=hoisted\n');
  const context = { npm, env: { HOME: root, npm_config_userconfig: userconfig } };
  const check = () => packageInstalledBytes(root, manifest, context);
  const remember = () => cacheInstalledBytes(root, manifest, 50, undefined, context);
  const cold = { bytes: 11, exact: false };
  assert.deepEqual(check(), cold);
  remember();
  assert.deepEqual(check(), { bytes: 50, exact: true });
  assert.deepEqual(
    packageInstalledBytes(root, manifest, {
      npm,
      env: { ...context.env, npm_config_node_gyp: '/synthetic/tool', npm_config_npm_version: '11' },
    }),
    { bytes: 50, exact: true },
  );
  writeFileSync(userconfig, 'install-strategy=nested\n');
  assert.deepEqual(check(), cold);
  remember();
  writeFileSync(npm, '// different synthetic npm executable');
  assert.deepEqual(check(), cold);
  remember();
  writeFileSync(join(root, 'scripts/agent-weight.mjs'), '// changed byte counter');
  assert.deepEqual(check(), cold);
  remember();
  writeFileSync(join(root, 'README.md'), 'v2');
  assert.deepEqual(check(), cold);
});

test('a Lane adding one MCP module above the ceiling fails preflight with the package smoke diagnostic', t => {
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({ ok: true }));
  const scratch = mkdtempSync(join(tmpdir(), 'forge-package-ceiling-lane-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const lane = join(scratch, 'lane');
  mkdirSync(lane);
  for (const path of ['src', 'scripts', 'package-lock.json', 'tsconfig.json'])
    cpSync(join(root, path), join(lane, path), { recursive: true });
  for (const path of ['node_modules', 'docs']) symlinkSync(join(root, path), join(lane, path), 'dir');
  const manifest = JSON.parse(manifestText);
  manifest.scripts['build:core'] =
    'node node_modules/@typescript/native/bin/tsc --noCheck --declaration false --noUncheckedSideEffectImports false && node scripts/build-cli-bundle.mjs';
  writeFileSync(join(lane, 'package.json'), JSON.stringify(manifest));
  mkdirSync(join(lane, 'tests/agent-weight-ledger'), { recursive: true });

  const baseline = readWeightBaseline(root);
  const probe = spawnSync(process.execPath, ['scripts/package-ceilings.mjs', '--runtime'], {
    cwd: root,
    encoding: 'utf8',
  });
  const before = JSON.parse(/^Package ceilings: (.+)$/m.exec(probe.stdout)?.[1] ?? '{}');
  assert.ok(Number.isFinite(before.mcpModules), probe.stderr);
  baseline.ceilings.mcpModules = before.mcpModules;
  writeFileSync(join(lane, 'tests/agent-weight-baseline.json'), JSON.stringify(baseline));
  writeFileSync(
    join(lane, 'tests/agent-weight-ledger', `${baselineHash(baseline)}.json`),
    JSON.stringify({ issue: '13ea93bf', reason: 'Synthetic replay of one added MCP module.' }),
  );

  // The same TypeScript emit as the package erases this cross-file type re-export. The
  // importer still loads exactly one new runtime module, which crosses the ceiling.
  const added = 'src/test-extra-mcp-module.ts';
  const importer = 'src/mcp-agent-workflow.ts';
  writeFileSync(join(lane, 'src/test-mcp-probe-type.ts'), 'export interface ProbeType { value: number }\n');
  writeFileSync(join(lane, added), "export { ProbeType } from './test-mcp-probe-type.js';\n");
  writeFileSync(
    join(lane, importer),
    `await import(new URL('./test-extra-mcp-module.js', import.meta.url).href);\n${readFileSync(join(lane, importer), 'utf8')}`,
  );
  const guard = 'tests/package-runtime-ceilings.test.mjs';
  writeFileSync(
    join(lane, guard),
    `
    import { spawnSync } from 'node:child_process';
    import test from 'node:test';
    test('runtime ceiling', () => {
      const run = spawnSync(process.execPath, ['scripts/package-ceilings.mjs', '--runtime'], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(run.stderr.trim());
    });
  `,
  );
  const plan = {
    status: 'planned',
    scope: 'package',
    reason: 'Changed package runtime inputs',
    tests: [guard],
    estimateMinutes: 0,
    command: null,
  };
  const receipt = runPreflight(lane, '22222222-2222-4222-8222-222222222222', 'a'.repeat(64), plan);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.failure.files, [guard]);
  const [diagnostic] = agentCeilingFindings({ mcpModules: before.mcpModules + 1 }, baseline, {
    partial: true,
  });
  assert.ok(receipt.failure.excerpt.includes(diagnostic), receipt.failure.excerpt);
  assert.match(receipt.failure.excerpt, /mcp: added modules\/chunks: .*test-extra-mcp-module\.js/);
});

test('a package probe that ignores SIGTERM is killed and reaped when its deadline expires', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-probe-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const processes = packageProbeProcesses(10);
  t.after(() => processes.dispose());
  const marker = join(root, 'ready');
  const watcher = watch(root);
  const ready = (async () => {
    for await (const event of watcher) if (event.filename === 'ready') return;
  })();
  const run = processes.run(
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    const { port1 } = new (require('node:worker_threads').MessageChannel)();
    port1.on('message', () => {});
    const { writeFileSync, renameSync } = require('node:fs');
    writeFileSync(process.argv[1] + '.tmp', String(process.pid));
    renameSync(process.argv[1] + '.tmp', process.argv[1]);
  `,
      marker,
    ],
    { cwd: root },
  );
  const rejected = assert.rejects(run, /Package probe timed out/);
  try {
    await ready;
    const pid = Number(readFileSync(marker, 'utf8'));
    t.mock.timers.tick(10);
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await watcher.return();
  }
});
