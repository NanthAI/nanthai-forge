// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Now recovery D/D2/D3 works in both themes with fakes, zero idle calls, retry pins and viewer authority', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const output = join(root, '.forge/b33a/browser'),
    screenshots = join(root, '.forge/b33a/screenshots');
  mkdirSync(screenshots, { recursive: true });
  await build({
    root: join(root, 'tests/fixtures/now-recovery'),
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
    const page = await browser.newPage({ viewport: { width: 1240, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => {
      errors.push(error.message);
      t.diagnostic(error.message);
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = join(output, path);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    const open = async (theme, role = 'owner') => {
      await page.goto(`https://forge.test/?theme=${theme}&role=${role}`);
      await page
        .getByText('Reverted from main', { exact: true })
        .waitFor()
        .catch(error => {
          t.diagnostic(JSON.stringify(errors));
          throw error;
        });
    };
    const first = () => page.locator('.fx-dec-revert');
    const screenshot = (state, theme) =>
      page.locator('.fx-needs-panel').screenshot({ path: join(screenshots, `${state}-${theme}.png`) });
    const calls = () => page.evaluate(() => window.__recovery.calls);
    for (const theme of ['light', 'dark']) {
      await open(theme);
      assert.deepEqual(await calls(), []);
      await page.clock.install();
      await page.clock.fastForward(60_000);
      assert.deepEqual(await calls(), [], 'a simulated idle minute makes no Convex calls');
      await page.clock.resume();
      assert.equal(await page.locator('.fx-dec').count(), 2);
      assert.equal(await page.locator('.fx-dec-age').count(), 0);
      assert.equal(await page.locator('.fx-dec-exact[open]').count(), 0);
      assert.match(await first().innerText(), /main audit failed 2 tests after it landed/);
      assert.equal(await first().getByRole('button', { name: 'Start a fix', exact: true }).count(), 1);
      const tones = await page.evaluate(() =>
        Object.fromEntries(
          ['revert', 'needs-fix'].map(kind => [
            kind,
            getComputedStyle(document.querySelector(`.fx-dec-${kind} .fx-dec-kind`)).color,
          ]),
        ),
      );
      assert.equal(tones.revert, theme === 'light' ? 'rgb(196, 43, 55)' : 'rgb(255, 111, 122)');
      assert.equal(tones['needs-fix'], theme === 'light' ? 'rgb(138, 88, 0)' : 'rgb(242, 184, 75)');
      await screenshot('D', theme);
      await first().getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await first().getByText('Close without a fix?', { exact: true }).count(), 1);
      assert.equal(await first().getByRole('button', { name: 'Start a fix', exact: true }).count(), 0);
      assert.equal(await first().getByRole('link', { name: 'Open Intent' }).count(), 0);
      await screenshot('D2', theme);
      await first().getByRole('button', { name: 'Keep', exact: true }).click();
      assert.deepEqual(await calls(), []);
      await first().getByRole('button', { name: 'Start a fix', exact: true }).click();
      await first().getByRole('button', { name: 'Starting…', exact: true }).waitFor();
      assert.equal(await first().getByRole('button', { name: 'Starting…', exact: true }).isDisabled(), true);
      assert.equal(await first().getByRole('button', { name: 'Close', exact: true }).count(), 0);
      await screenshot('D3', theme);
      assert.deepEqual(
        (await calls()).map(call => call.name),
        ['projectHostedChannels:current', 'projectHostedStart:start'],
      );
      await page.evaluate(() => window.__recovery.release(true));
      await first().getByRole('button', { name: 'Start a fix', exact: true }).waitFor();
      await page.getByRole('alert').waitFor();
      await first().getByRole('button', { name: 'Start a fix', exact: true }).click();
      await first().getByRole('button', { name: 'Starting…', exact: true }).waitFor();
      const attempts = await calls();
      assert.deepEqual(attempts[2], attempts[1], 'unknown start reply reuses operation id and main pins');
      assert.equal(attempts[1].args.noticeVersion, 1);
      assert.equal(attempts[1].args.intent.kind, 'existing');
      await page.evaluate(() => window.__recovery.release());
      await page.waitForURL(/#fix-00000000-0000-4000-8000-000000000003$/);
      await page.evaluate(() => window.__recovery.reland());
      await page.getByText('Nothing needs you.', { exact: true }).first().waitFor();
      assert.equal(await page.locator('.fx-dec').count(), 0);
      await open(theme, 'viewer');
      assert.equal(await page.locator('.fx-answers button').count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Open Intent', exact: true }).count(), 2);
      await screenshot('D-viewer', theme);
      await open(theme, 'contributor');
      assert.equal(await page.getByRole('button', { name: 'Start a fix', exact: true }).count(), 2);
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 0);
    }
    await open('light');
    await first().getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.__recovery.setFailure(true));
    await first().getByRole('button', { name: 'Close Intent', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.evaluate(() => window.__recovery.setFailure(false));
    await first().getByRole('button', { name: 'Close Intent', exact: true }).click();
    await first().waitFor({ state: 'detached' });
    const closed = await calls();
    assert.equal(closed.length, 2);
    assert.deepEqual(closed[0], closed[1]);
    assert.equal(closed[0].name, 'projectWorkCommand:command');
    assert.equal(JSON.parse(closed[0].args.command).status, 'abandoned');
    await page.setViewportSize({ width: 390, height: 900 });
    await open('dark');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot('D-mobile', 'dark');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
