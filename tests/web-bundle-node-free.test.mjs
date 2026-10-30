// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** 2026-10-28: web/src reached src/native-import-merge.ts through landing-waiting, the built Shell chunk called
 * createRequire() and the whole app showed "Could not load Forge.". Build the real web app and refuse any chunk
 * that carries Node-only code. The build itself also fails on a first-party Node builtin import. */
test('the browser bundle contains no Node-only code', () => {
  const out = mkdtempSync(join(tmpdir(), 'forge-web-bundle-'));
  try {
    const build = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        'web',
        '--mode',
        'hosted',
        '--config',
        'web/vite.config.ts',
        '--outDir',
        out,
        '--emptyOutDir',
        '--logLevel',
        'warn',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(build.status, 0, `web build failed:\n${build.stdout}\n${build.stderr}`);
    const assets = join(out, 'assets');
    const names = builtinModules
      .filter(name => !name.startsWith('_'))
      .map(name => name.replace(/^node:/, ''));
    const offenders = [];
    for (const file of readdirSync(assets).filter(name => name.endsWith('.js'))) {
      const code = readFileSync(join(assets, file), 'utf8');
      if (/\bcreateRequire\b/.test(code)) offenders.push(`${file}: createRequire`);
      for (const match of code.matchAll(/["'`](node:[a-z_/]+)["'`]/g))
        if (names.includes(match[1].slice(5))) offenders.push(`${file}: ${match[1]}`);
    }
    assert.deepEqual([...new Set(offenders)], [], 'Node-only code reached the browser bundle');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
