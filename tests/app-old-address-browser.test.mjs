// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Old addresses in the served app (Item d61f36fe): a plain old path replaces itself with its new address before any
// screen starts, and an old id-only link is taken by the rebuilt app (which resolves it with one read once signed in),
// never by the old screens. Built without a backend, so no read can be made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserExecutable } from './browser-runtime.mjs';
import { moduleUrl } from './convex-module.mjs';

const { ROOT } = await import(moduleUrl('../web/src/app/paths.ts'));

test('served old addresses reach the rebuilt app: plain paths redirect, id-only links resolve in it', async t => {
  const executablePath = browserExecutable(t);
  if (!executablePath) return;
  const out = await mkdtemp(join(tmpdir(), 'forge-old-address-'));
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
  const origin = 'https://forge.test';
  const open = async address => {
    const page = await browser.newPage();
    const old = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      // Every page address serves the app shell, as the CDN does.
      if (route.request().isNavigationRequest()) return route.fulfill({ path: join(out, 'app.html') });
      if (/Hosted-|legacy/.test(url.pathname)) old.push(url.pathname);
      return route.fulfill({ path: join(out, url.pathname) });
    });
    await page.goto(origin + address);
    await page.getByRole('heading', { name: 'Forge backend is not configured' }).waitFor();
    return { page, old };
  };
  const lane = '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35';
  for (const [from, to] of [
    ['/projects?request=r1', `${ROOT}/account?request=r1`],
    ['/settings', `${ROOT}/account/people`],
    ['/mara/tide-pool/activity#top', `${ROOT}/mara/tide-pool?view=needs#fyi`],
    ['/mara/tide-pool/needs-me/held', `${ROOT}/mara/tide-pool?view=needs#fyi`],
    ['/mara/tide-pool/needs-me/loose-ends', `${ROOT}/mara/tide-pool?view=needs#loose-ends`],
    ['/mara/tide-pool/planning?planningItem=abcd1234', `${ROOT}/mara/tide-pool/plan/abcd1234`],
  ]) {
    const { page, old } = await open(from);
    assert.equal(page.url(), origin + to, from);
    assert.equal(await page.locator('html[data-ds]').count(), 1, `${from} opens the rebuilt app`);
    assert.deepEqual(old, [], `${from} loads no old screen`);
    await page.close();
  }
  // Ids only: the address stays (it is resolved after sign-in) and the rebuilt app, not the old one, holds the page.
  for (const from of [
    `/projects?project=abc123&lane=${lane}`,
    `/mara/tide-pool/decisions/d-D40sHlt6TD2eIWpLjwx9NQ`,
  ]) {
    const { page, old } = await open(from);
    assert.equal(page.url(), origin + from);
    assert.equal(await page.locator('html[data-ds]').count(), 1, `${from} opens the rebuilt app`);
    assert.deepEqual(old, [], `${from} loads no old screen`);
    await page.close();
  }
});
