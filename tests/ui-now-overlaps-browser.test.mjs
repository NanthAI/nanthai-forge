// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
test('Now overlaps match A-C in light, dark and mobile; one shared subscription, zero idle calls, batch retry and settlement', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const output = join(root, '.forge/b33b/browser'),
    screenshots = join(root, '.forge/b33b/screenshots');
  mkdirSync(screenshots, { recursive: true });
  await build({
    root: join(root, 'tests/fixtures/now-overlaps'),
    configFile: false,
    resolve: {
      alias: { './landing-train-plan.js': join(root, 'tests/fixtures/now-recovery/native-plan.ts') },
    },
    envDir: false,
    base: '/',
    logLevel: 'silent',
    build: { outDir: output, emptyOutDir: true },
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(output, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      return existsSync(file)
        ? route.fulfill({
            contentType: file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.css')
                ? 'text/css'
                : 'text/html',
            body: readFileSync(file),
          })
        : route.fulfill({ status: 404, body: '' });
    });
    const calls = () => page.evaluate(() => window.__overlaps.calls);
    const open = async (theme, state = 'C', extra = '') => {
      await page.goto(`https://forge.test/?theme=${theme}&state=${state}${extra}`);
      await page.locator('.fx-needs-panel').waitFor();
    };
    const first = () => page.locator('.fx-dec-overlap').first();
    for (const theme of ['light', 'dark']) {
      await open(theme);
      await page.getByRole('button', { name: 'Acknowledge all (4)' }).waitFor();
      assert.equal(await page.locator('.fx-dec-overlap').count(), 2);
      assert.equal(await page.locator('.fx-person-overlaps').count(), 4);
      assert.equal(await page.locator('.fx-person-stale').count(), 2);
      assert.match(await page.locator('.fx-now-desktop-situation').innerText(), /9 unanswered/);
      assert.match(await page.locator('.fx-needs-panel .fx-panel-h').innerText(), /Answered today · 0/);
      assert.match(await first().innerText(), /41 min/);
      const initial = await calls();
      assert.equal(
        initial.filter(call => call.name === 'projectHostedOverlapAcks:list').length,
        1,
        'shared child does not subscribe twice',
      );
      assert.equal(initial.length, 6, 'only one subscription added to the five existing reads');
      await page.clock.install();
      await page.clock.fastForward(60_000);
      await page.evaluate(() => window.__overlaps.rerender());
      assert.deepEqual(await calls(), initial, 'an idle minute and render make zero extra function calls');
      await page.clock.resume();
      await page.screenshot({ path: join(screenshots, `C-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Acknowledge all (4)' }).click();
      assert.equal(await first().getByRole('button', { name: 'Acknowledge all (4)' }).isDisabled(), true);
      await page.evaluate(() => window.__overlaps.release(true));
      await first().getByRole('button', { name: 'Retry: Acknowledge' }).waitFor();
      await page.getByRole('alert').waitFor();
      await first().getByRole('button', { name: 'Retry: Acknowledge' }).click();
      const attempts = (await calls()).filter(call => call.kind === 'mutation');
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1], 'retry retains batch and per-notice UUIDs');
      assert.equal(JSON.parse(attempts[0].args.request).answers.length, 4);
      assert.equal(JSON.parse(attempts[0].args.request).answers[0].text, 'Acknowledged from Now by Dino');
      await page.evaluate(() => window.__overlaps.release());
      await page.getByText('Acknowledged as you.', { exact: true }).waitFor();
      await page.screenshot({ path: join(screenshots, `B3-${theme}.png`), fullPage: true });
      await page.evaluate(() => window.__overlaps.settle(true));
      await first().getByRole('button', { name: 'Acknowledge', exact: true }).waitFor();
      assert.equal(
        await page.locator('.fx-dec-overlap').count(),
        2,
        'a new notice keeps the Lane card and restores its answer button',
      );
      assert.equal(await first().getByText('Acknowledged as you.', { exact: true }).count(), 0);
      assert.match(await page.locator('.fx-needs-panel .fx-panel-h').innerText(), /Answered today · 4/);
      for (const [state, count] of [
        ['A', 0],
        ['B', 1],
        ['B2', 0],
        ['B3', 0],
      ]) {
        await open(theme, state);
        assert.equal(await page.locator('.fx-dec-overlap').count(), count);
        await page.screenshot({ path: join(screenshots, `${state}-${theme}.png`), fullPage: true });
      }
      await open(theme, 'C', '&partial=1');
      await page.getByText('Showing the most recent items only.', { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 900 });
      await open(theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(screenshots, `C-mobile-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const mockup = process.env.FORGE_NOW_OVERLAP_MOCKUP;
    if (mockup && existsSync(mockup)) {
      const reference = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await reference.setContent(readFileSync(mockup, 'utf8'));
      for (const theme of ['light', 'dark']) {
        await reference.evaluate(theme => (document.documentElement.dataset.theme = theme), theme);
        await reference.locator('#s-many').scrollIntoViewIfNeeded();
        await reference.screenshot({ path: join(screenshots, `mockup-C-${theme}.png`) });
        await reference.setViewportSize({ width: 390, height: 900 });
        await reference.locator('#s-many').scrollIntoViewIfNeeded();
        await reference.screenshot({ path: join(screenshots, `mockup-C-mobile-${theme}.png`) });
        await reference.setViewportSize({ width: 1440, height: 1000 });
      }
      await reference.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
