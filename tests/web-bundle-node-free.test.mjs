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
 * that carries Node-only code or fails module evaluation. Synthetic public config exercises the configured app,
 * and this fixed smoke test participates in every code selection. */
test('the configured browser bundle contains no Node-only code and evaluates every chunk', () => {
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
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          VITE_CONVEX_URL: 'https://forge-smoke.convex.cloud',
          VITE_CONVEX_SITE_URL: 'https://forge-smoke.convex.site',
          VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('smoke.clerk.accounts.dev$').toString('base64')}`,
          VITE_GITHUB_APP_SLUG: 'forge-smoke',
          VITE_FORGE_DEMO_REPOSITORY: 'synthetic/demo',
        },
      },
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
    const smoke = spawnSync(process.execPath, ['scripts/web-smoke-load.mjs', out], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(smoke.status, 0, `configured web smoke failed:\n${smoke.stdout}\n${smoke.stderr}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
