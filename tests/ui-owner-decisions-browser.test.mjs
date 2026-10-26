// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
test('owner decision routes filter, navigate and disclose locally in both themes without idle network calls', async t => {
  if (!existsSync(chromium.executablePath())) {
    t.skip(
      'Playwright Chromium is not installed in this clean check environment; run the browser fixture in the QA Lane.',
    );
    return;
  }
  const server = await createServer({
    root: `${root}/web`,
    configFile: false,
    logLevel: 'silent',
    cacheDir: `${root}/node_modules/.cache/d1-vite`,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    resolve: {
      alias: [{ find: /^convex\/react$/, replacement: `${root}/tests/fixtures/s1b-convex-react.mjs` }],
    },
    plugins: [
      {
        name: 'd1-fixture',
        configureServer(s) {
          s.middlewares.use('/fixture.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<html><head><title>Owner decisions fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/fixtures/owner-decisions-preview.tsx"></script></body></html>`,
            );
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  let requests = 0;
  page.on('request', () => requests++);
  const base = `http://127.0.0.1:${server.httpServer.address().port}/fixture.html`;
  const output = process.env.FORGE_QA_SCREENSHOTS;
  if (output) mkdirSync(output, { recursive: true });
  const capture = async (name, theme) => {
    assert.equal(
      await page.locator('html').getAttribute('data-theme'),
      theme,
      'captured theme matches the requested theme',
    );
    if (output) await page.screenshot({ path: `${output}/${name}-${theme}.png`, fullPage: true });
  };
  if (output && process.env.FORGE_D1_REFERENCE_URL) {
    for (const theme of ['light', 'dark'])
      for (const [name, file] of [
        ['list', '01-project-decisions-list.html'],
        ['intent-review', '02-intent-and-review-context.html'],
        ['record', '04-superseded-record.html'],
      ]) {
        await page.goto(`${process.env.FORGE_D1_REFERENCE_URL}/${file}`);
        await page.evaluate(theme => (document.documentElement.dataset.theme = theme), theme);
        await capture(`reference-${name}`, theme);
        if (name === 'intent-review') {
          await page
            .locator('.fx-odec')
            .first()
            .screenshot({ path: `${output}/reference-intent-record-${theme}.png` });
          await page
            .locator('details')
            .filter({ hasText: 'Owner decisions in effect' })
            .screenshot({ path: `${output}/reference-disclosure-${theme}.png` });
        }
      }
  }
  for (const theme of ['light', 'dark']) {
    await page.goto(`${base}?surface=list&theme=${theme}`);
    await page.getByRole('heading', { name: 'Owner decisions', exact: true }).first().waitFor();
    assert.equal(await page.locator('.fx-odec').count(), 12);
    await capture('list-active', theme);
    await page.getByRole('button', { name: 'Show all', exact: true }).click();
    assert.equal(await page.locator('.fx-odec').count(), 19);
    await page.getByRole('button', { name: 'Superseded', exact: true }).click();
    assert.equal(await page.locator('.fx-odec').count(), 1);
    assert.equal(await page.locator('.fx-odec-superseded').count(), 1);
    assert.match(await page.locator('.fx-odec-day').innerText(), /Today/i);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    assert.equal(await page.locator('.fx-odec').count(), 20);
    await page.getByLabel('Decision target').selectOption('10000000-0000-4000-8000-000000000001');
    assert.equal(await page.locator('.fx-odec').count(), 1);
    await page.getByLabel('Decision target').selectOption('all');
    await capture('list', theme);
    const css = await page
      .locator('.fx-odec-what')
      .first()
      .evaluate(el => ({
        clamp: getComputedStyle(el).webkitLineClamp,
        overflow: getComputedStyle(el).overflow,
      }));
    assert.equal(css.clamp, 'none');
    assert.notEqual(css.overflow, 'hidden');
    await page.locator('.fx-odec-superseded .fx-odec-what a').click();
    await page.getByText('Exact record', { exact: true }).waitFor();
    assert.match(await page.locator('.fx-odec-chain').innerText(), /Superseded by/);
    await capture('record', theme);
    await page.locator('.fx-odec-chain a').first().click();
    await page.getByText('Exact record', { exact: true }).waitFor();
    assert.match(await page.locator('.fx-odec-chain').innerText(), /Replaces/);
    await capture('replacement', theme);
    await page.goto(`${base}?surface=intent&theme=${theme}`);
    await page.getByRole('heading', { name: 'Owner decisions', exact: true }).waitFor();
    assert.equal(await page.locator('.fx-odec').count(), 1);
    const headings = await page.locator('.fx-lane-col > .fx-panel h2').allTextContents();
    assert.ok(headings.indexOf('Details') < headings.indexOf('Owner decisions'));
    assert.ok(headings.indexOf('Owner decisions') < headings.indexOf('Lanes'));
    assert.equal(await page.getByText(/^Owner decision recorded/).count(), 1);
    await capture('intent', theme);
    if (output) await page.locator('.fx-odec').screenshot({ path: `${output}/intent-record-${theme}.png` });
    await page.goto(`${base}?surface=review&theme=${theme}`);
    await page.locator('.fx-odec-disclosure').waitFor();
    assert.equal(await page.locator('.fx-odec-disclosure').getAttribute('open'), null);
    await capture('review-collapsed', theme);
    if (output)
      await page.locator('.fx-odec-disclosure').screenshot({ path: `${output}/disclosure-${theme}.png` });
    await page.locator('.fx-odec-disclosure summary').click();
    assert.equal(await page.locator('.fx-odec-disclosure').getAttribute('open'), '');
    assert.ok((await page.locator('.fx-odec-compact').count()) > 1);
    await capture('review-expanded', theme);
    await page.goto(`${base}?surface=now&theme=${theme}`);
    await page.getByRole('heading', { name: 'Owner decisions', exact: true }).waitFor();
    assert.equal(await page.locator('.fx-odec-compact').count(), 3);
    await capture('now', theme);
    // Fixture uses the production components: settled tabs have no component-originated requests.
    await page.waitForLoadState('networkidle');
    const settled = requests;
    await page.waitForTimeout(1100);
    assert.equal(requests, settled, 'idle decision components issue no network calls');
    await page.goto(`${base}?surface=now&theme=${theme}&stale=1`);
    await page.getByRole('heading', { name: 'Now', exact: true }).waitFor();
    assert.equal(await page.locator('.fx-odec-compact').count(), 0);
    await page.goto(`${base}?surface=list&theme=${theme}&empty=1`);
    await page.getByText('No owner decisions yet.', { exact: true }).waitFor();
    await capture('empty', theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}?surface=list&theme=${theme}`);
    await page.getByRole('heading', { name: 'Owner decisions', exact: true }).first().waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture('list-mobile', theme);
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await page.goto(`${base}?surface=cache`);
  await page.getByTestId('cache-count').filter({ hasText: /^20$/ }).waitFor();
  assert.equal(await page.getByTestId('cache-reads').innerText(), '2');
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Unrelated Work revision', exact: true }).click();
  await page.waitForTimeout(1100);
  assert.equal(
    await page.getByTestId('cache-reads').innerText(),
    '2',
    'unchanged decision version adds zero Convex calls',
  );
  await page.getByRole('button', { name: 'New decision version', exact: true }).click();
  await page.getByTestId('cache-count').filter({ hasText: /^21$/ }).waitFor();
  assert.equal(await page.getByTestId('cache-reads').innerText(), '4');
  assert.deepEqual(errors, []);
});
