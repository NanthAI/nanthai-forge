// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserExecutable } from './browser-runtime.mjs';

test('the served account shell repairs its original doubled-slash URL before choosing the app', async t => {
  const executablePath = browserExecutable(t);
  if (!executablePath) return;
  const out = await mkdtemp(join(tmpdir(), 'forge-account-route-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const { build } = await import('vite');
  await build({
    configFile: join(web, 'vite.config.ts'),
    root: web,
    mode: 'hosted',
    envDir: false,
    define: { 'import.meta.env.VITE_CONVEX_URL': 'undefined' },
    logLevel: 'error',
    build: { outDir: out },
  });

  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = 'https://forge.test';
  const requests = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      requests.push(url.href);
      return route.abort();
    }
    if (route.request().isNavigationRequest()) {
      requests.push(url.pathname);
      // Model a CDN 200 at the raw URL, with no redirect to change location.pathname.
      return route.fulfill({ path: join(out, 'app.html') });
    }
    return route.fulfill({ path: join(out, url.pathname) });
  });
  await page.addInitScript(() => history.replaceState({ from: 'fixture' }, ''));
  await page.goto(`${origin}//-/account/devices?tab=current#details`);
  await page.getByRole('heading', { name: 'Forge backend is not configured' }).waitFor();
  assert.equal(await page.locator('html[data-ds]').count(), 1);
  assert.equal(page.url(), `${origin}/-/account/devices?tab=current#details`);
  assert.deepEqual(await page.evaluate(() => history.state), { from: 'fixture' });
  assert.deepEqual(requests, ['//-/account/devices']);
});
