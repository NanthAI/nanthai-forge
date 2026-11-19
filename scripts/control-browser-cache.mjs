// SPDX-License-Identifier: Apache-2.0
// Install only the pinned public browser package, without the runner's credentials.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { isMainModule } from './main-module.mjs';
import { childEnv } from './child-env.mjs';

export function browserInstallEnv(home, cache, source = process.env) {
  return childEnv({
    source,
    extra: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      XDG_STATE_HOME: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      PLAYWRIGHT_BROWSERS_PATH: resolve(cache),
      npm_config_cache: source.npm_config_cache || join(homedir(), '.npm'),
      npm_config_ignore_scripts: 'true',
    },
  });
}
export function installBrowser(version, cache) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '') || !cache)
    throw new Error('Browser cache install requires the exact pinned Playwright version and cache path.');
  const base = dirname(process.execPath);
  const npm = [
    join(base, '../lib/node_modules/npm/bin/npm-cli.js'),
    join(base, 'node_modules/npm/bin/npm-cli.js'),
  ].find(existsSync);
  if (!npm) throw new Error('The runner Node installation must include npm.');
  const home = mkdtempSync(join(tmpdir(), 'forge-browser-seed-'));
  try {
    const child = spawnSync(
      process.execPath,
      [
        npm,
        'exec',
        '--yes',
        '--ignore-scripts',
        `--package=playwright@${version}`,
        '--',
        'playwright',
        'install',
        'chromium',
      ],
      {
        env: browserInstallEnv(home, cache),
        stdio: 'inherit',
      },
    );
    if (child.status !== 0) throw new Error('Pinned browser cache installation failed.');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
if (isMainModule(import.meta.url))
  installBrowser(process.env.FORGE_BROWSER_VERSION, process.env.PLAYWRIGHT_BROWSERS_PATH);
