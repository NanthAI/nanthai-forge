// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserInstallEnv, installBrowser } from '../scripts/control-browser-cache.mjs';

test('browser cache seed isolates HOME and drops runner, Forge and npm credentials', () => {
  const env = browserInstallEnv('/synthetic/private-home', '/synthetic/browser-cache', {
    PATH: '/synthetic/bin',
    HOME: '/synthetic/original-home',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-secret',
    ACTIONS_RUNTIME_TOKEN: 'synthetic-secret',
    GITHUB_TOKEN: 'synthetic-secret',
    FORGE_AUTH_TOKEN: 'synthetic-secret',
    NPM_TOKEN: 'synthetic-secret',
    NODE_OPTIONS: '--require=untrusted',
    npm_config_userconfig: '/synthetic/private-config',
  });
  assert.equal(env.HOME, '/synthetic/private-home');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/synthetic/browser-cache');
  assert.equal(env.npm_config_ignore_scripts, 'true');
  for (const name of [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'GITHUB_TOKEN',
    'FORGE_AUTH_TOKEN',
    'NPM_TOKEN',
    'NODE_OPTIONS',
    'npm_config_userconfig',
  ])
    assert.equal(env[name], undefined, name);
});
test('browser cache seed rejects an unpinned package argument before any installation', () => {
  for (const version of ['latest', '1.2.3 --other', '1.2.3; command', '', undefined])
    assert.throws(() => installBrowser(version, '/synthetic/cache'), /exact pinned Playwright version/);
});
