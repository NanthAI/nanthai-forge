// SPDX-License-Identifier: Apache-2.0
// Real billing components in the account frame, using synthetic stub data without an authenticated session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_BILLING_SHOTS;
const viewport = width => ({ width, height: width === 390 ? 844 : 1000 });

async function fixture(out) {
  const entry = 'virtual:billing-test';
  const source = `    import ${JSON.stringify(join(root, 'web/src/shell/mark.css'))};
    import ${JSON.stringify(join(root, 'web/src/ui/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ui/components.css'))};
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import Billing from ${JSON.stringify(join(root, 'web/src/billing/Home.tsx'))};
    import {AccountFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    createRoot(document.getElementById('root')).render(h(AccountFrame,{place:'billing',back:null,
      controls:{viewerHandle:'sample-owner',onPalette(){},onKeys(){}}},h(Billing)));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'billing-fixture',
        resolveId(id) {
          if (id === entry) return '\0billing-test.js';
        },
        load(id) {
          if (id === '\0billing-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('billing-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Billing · Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

test('billing home: monthly pool, bounded project list, chart/table, navigation and recovery in both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-billing-home-'));
  const html = await fixture(out);
  const browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (width = 1440, sample = 'pro', view = 'owner', theme = 'dark') => {
    const page = await browser.newPage({ viewport: viewport(width) });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html';
      return route.fulfill({
        contentType: asset ? contentType : 'text/html',
        body: asset ? readFileSync(file) : html,
      });
    });
    await page.goto(`https://forge.test/-/account/billing?sample=${sample}&view=${view}`);
    await page.locator('h1').waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return page;
  };
  const page = await open();
  assert.match(await page.title(), /Billing/);
  assert.match(await page.locator('main').textContent(), /746 of 1,000 included landings used/);
  await page.getByRole('button', { name: 'nforge billing', exact: true }).click();
  assert.match(await page.locator('#billing-cli').textContent(), /run allowance  separate/);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  assert.equal(await page.getByRole('table', { name: 'Monthly landing counts, sample data' }).count(), 1);
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.locator('.head').getByRole('link', { name: 'Change plan' }).click();
  assert.match(page.url(), /screen=plan/);
  assert.match(await page.locator('h1').textContent(), /Change plan/);
  await page.getByRole('link', { name: 'Back to the month' }).click();
  assert.equal(await page.getByRole('region', { name: 'This month', exact: true }).count(), 1);

  await page.goto('https://forge.test/-/account/billing?sample=pro&screen=__proto__');
  await page.getByRole('region', { name: 'This month', exact: true }).waitFor();
  assert.match(await page.locator('h1').textContent(), /Billing/);

  const worst = await open(390, 'worst');
  await worst.getByRole('button', { name: 'Show 2 more', exact: true }).click();
  assert.equal(await worst.locator('table.stack tbody tr').count(), 10);
  const member = await open(390, 'pro', 'member');
  assert.equal(await member.getByRole('region', { name: 'Payment', exact: true }).count(), 0);
  assert.doesNotMatch(await member.locator('main').textContent(), /SAMPLE-0004|ending 0000/);
  const error = await open(390, 'pro', 'error');
  assert.match(await error.getByRole('alert').textContent(), /last snapshot/);
  await error.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.equal(await error.getByRole('alert').count(), 0);
  assert.match(await error.locator('main').textContent(), /746 of 1,000/);
  const first = await open(390, 'first');
  assert.match(await first.locator('main').textContent(), /No landings yet/);
  assert.match(await first.locator('main').textContent(), /No invoices/);
  const loading = await open(390, 'pro', 'loading');
  assert.equal(await loading.locator('[aria-busy=true]').count(), 1);

  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      const draw = await open(width, 'pro', 'owner', theme);
      await draw.evaluate(() => document.fonts.ready);
      await draw.addScriptTag({ path: axe });
      const violations = await draw.evaluate(async () =>
        (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations.map(v => ({
          id: v.id,
          nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })),
        })),
      );
      assert.deepEqual(violations, [], `${width}/${theme}: axe`);
      assert(
        await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}/${theme}: no horizontal page scroll`,
      );
      await draw.getByRole('button', { name: 'nforge billing', exact: true }).focus();
      await draw.keyboard.press('Enter');
      assert.equal(await draw.locator('#billing-cli').count(), 1, 'keyboard opens the command reply');
      await draw.keyboard.press('Enter');
      await draw.locator('h1').click();
      if (shots) {
        await draw.screenshot({ path: join(shots, `billing-${width}-${theme}.png`), fullPage: true });
        await draw.screenshot({ path: join(shots, `billing-${width}-${theme}-viewport.png`) });
      }
      await draw.close();
    }
  assert.deepEqual(errors, [], 'no runtime errors');
});
