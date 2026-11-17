// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { testBrowserPath } from '../scripts/test-browser-path.mjs';

test('browser cache survives private test HOME and XDG under heavy', () => {
  const expected = testBrowserPath();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/check-runtime.mjs',
      '--input-type=module',
      '-e',
      `
    import { chromium } from 'playwright';
    console.log(JSON.stringify({cache: process.env.PLAYWRIGHT_BROWSERS_PATH, executable: chromium.executablePath()}));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.cache, expected);
  // A machine without browsers still gets the original missing-browser result, never a private-home path.
  if (expected !== '0') assert(actual.executable.startsWith(expected));
});

test('browser cache keeps explicit, hermetic and platform-specific install locations', () => {
  assert.equal(testBrowserPath({ PLAYWRIGHT_BROWSERS_PATH: '0' }), '0');
  assert.equal(
    testBrowserPath({ PLAYWRIGHT_BROWSERS_PATH: 'browsers', INIT_CWD: '/project' }),
    '/project/browsers',
  );
  assert.equal(testBrowserPath({}, 'darwin', '/synthetic'), '/synthetic/Library/Caches/ms-playwright');
  assert.equal(testBrowserPath({ XDG_CACHE_HOME: '/cache' }, 'linux', '/synthetic'), '/cache/ms-playwright');
  assert.equal(testBrowserPath({ LOCALAPPDATA: '/apps' }, 'win32', '/synthetic'), '/apps/ms-playwright');
});
