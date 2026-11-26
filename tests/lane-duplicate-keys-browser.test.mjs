// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item f9309eec: the Lane page logged React "two children with the same key" for ids that repeat in its source rows.
// This mounts the Lane review screen in a real browser on a fixture whose source data repeats a file path, through a
// development React build (the production build never logs key warnings), and fails on any console error. 1440 px and
// 390 px both render the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { buildBrowserFixture, routeBrowserFixture } from './browser-fixture.mjs';

const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

test('f9309eec: the review screen renders repeated source rows without a duplicate-key error', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-lane-keys-'));
  const { html } = await buildBrowserFixture(out, {
    entry: 'tests/browser/lane-duplicate-keys.tsx',
    title: 'Duplicate keys',
    htmlAttrs: 'lang="en"',
    css: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const browser = await chromium.launch(launchOptions);
  try {
    for (const viewport of [DESK, PHONE]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => message.type() === 'error' && errors.push(message.text()));
      await routeBrowserFixture(page, out, html, { paths: ['/keys.html'] });
      await page.goto('https://forge.test/keys.html');
      await page
        .locator('section[aria-label="The change"]')
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
      assert.equal(await page.locator('.lr-file').count(), 3, 'src/a.ts once, then b and c');
      await context.close();
      assert.deepEqual(errors, [], `review at ${viewport.width}: no console errors`);
    }
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
