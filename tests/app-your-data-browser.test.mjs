// SPDX-License-Identifier: Apache-2.0
// Account > Your data as real components with synthetic rows (Item 17cdc774): what Forge holds kind by kind, the
// take-out rows, the deletion's exact before-list behind a typed handle, and every state passing axe with no sideways
// scroll at desk and phone width in both themes. Set FORGE_DATA_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import { settleBrowserPage } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_DATA_SHOTS;

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { YourDataView } from ${JSON.stringify(join(root, 'web/src/app/data/YourData.tsx'))};
import { AccountFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const kinds = ['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'];
const row = (id, label, note) => ({ id, pin: '0'.repeat(64), label, ...(note ? { note } : {}) });
const none = () => Object.fromEntries(kinds.map(kind => [kind, { rows: [], more: false }]));
const sample = none();
sample.project = { rows: [row('p1', 'stream-parser'), row('p2', 'docs-site', 'trash')], more: false };
sample.team = { rows: [row('t1', 'parsers')], more: false };
sample.agent = { rows: [row('a1', 'nightly-builder')], more: false };
sample.interest = { rows: [row('i1', 'Watched repository')], more: false };
const long = 'a-very-long-project-name-that-keeps-going-well-past-any-sensible-width-for-a-row-and-then-some';
const worst = none();
worst.project = { rows: Array.from({ length: 10 }, (_, i) => row('w' + i, i ? 'project-' + i : long)), more: true };
worst.view = { rows: [row('v1', 'م')], more: false };
const receipts = [
  { operationId: 'op-1', request: 'r', stage: 'running', at: Date.parse('2026-11-16T10:00:00Z') },
  { operationId: 'op-2', request: 'r', stage: 'completed', at: Date.parse('2026-11-01T10:00:00Z') },
];
const shared = [
  { kind: 'teams', id: 'tm', label: 'Their team' },
  { kind: 'projects', id: 'pc', label: long },
  { kind: 'readers', id: 'ir', label: 'A repository shared with you' },
];
const mode = new URLSearchParams(location.search).get('data') || 'sample';
const held = ['empty', 'leave-only'].includes(mode) ? none() : mode === 'worst' ? worst : sample;
const owned = held => kinds.flatMap(kind => held[kind].rows.map(r => ({ ...r, kind })));
const review =
  mode === 'review' ? { owned: owned(sample), shared, incoming: 't' }
  : mode === 'worst-review' ? { owned: Array.from({ length: 50 }, (_, i) => ({ ...row('w' + i, i ? 'project-' + i : long), kind: 'project' })), shared: [], incoming: 't' }
  : mode === 'leave-only' ? { owned: [], shared, incoming: 't' }
  : null;
const run =
  mode === 'refused' ? { operationId: 'op-3', stage: 'preparing', status: 'failed', words: 'What is shared with you changed after your review. Review again; nothing was deleted.', stale: true }
  : mode === 'unanswered' ? { operationId: 'op-3', stage: 'preparing', status: 'unknown', words: 'Forge did not answer, so this deletion may or may not have gone ahead. Check again to find out.' }
  : mode === 'pass-refused' ? { operationId: 'op-3', stage: 'running', status: 'failed', words: 'Only the owner person can permanently delete projects.', stale: false }
  : mode === 'waiting' ? { operationId: 'op-3', stage: 'running', status: 'waiting' }
  : null;
function Page() {
  return (
    <AccountFrame place="data" back={null} controls={{ viewerHandle: 'sample-owner', onPalette() {}, onKeys() {} }}>
      <YourDataView held={held} failed={false} retry={() => {}} receipts={mode === 'empty' ? [] : receipts}
        handle="sample-owner" busy={null} exported={null} review={review} run={run} pending={null} error=""
        onDownload={() => {}} onReview={() => {}} onCancel={() => {}}
        onDelete={() => { document.body.dataset.deleted = 'asked'; }} onReconcile={() => {}}
        onRetry={() => { document.body.dataset.retried = 'yes'; }} onStartOver={() => { document.body.dataset.over = 'yes'; }}
        onContinue={() => {}} />
    </AccountFrame>
  );
}
createRoot(document.getElementById('root')).render(<Page />);
`;

test('your data: holdings, take-out, the before-list behind the typed handle, and every state passes axe', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-data-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your data · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(join(temp, 'fixture.tsx'), fixture);
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const open = async (width, theme, data) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const path = url.pathname.slice(1);
      const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
      const asset = path && existsSync(file) && !file.endsWith('/');
      return route.fulfill({
        contentType: !asset
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.woff2')
                ? 'font/woff2'
                : 'application/octet-stream',
        body: readFileSync(asset ? file : join(out, 'fixture.html')),
      });
    });
    await page.goto(`https://forge.test/-/account?data=${data}`);
    await page.locator('main h1').first().waitFor();
    // Settle the theme switch's colour transitions before axe reads the colours.
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    await settleBrowserPage(page);
    return { page, errors, context };
  };
  const check = async (page, label) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${label}: no sideways scroll`,
    );
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const result = await page.evaluate(() =>
      window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
    );
    assert.deepEqual(
      result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
      [],
      `${label}: axe`,
    );
  };
  {
    const { page, errors, context } = await open(1440, 'light', 'sample');
    const main = page.locator('main');
    assert.match(
      await main.locator('.head').textContent(),
      /Forge holds 2 projects, 1 agent access grant, 1 team and 1 watched repository for you\./,
    );
    assert.match(await main.textContent(), /nforge clone PROJECT-URL FOLDER/);
    assert.equal(
      await page.getByRole('button', { name: 'Continue' }).count(),
      1,
      'only the unfinished deletion continues',
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    // The exact before-list: every owned row by kind, what is shared, and the delete key needs the handle.
    const { page, context } = await open(390, 'dark', 'review');
    const main = page.locator('main');
    assert.match(await main.textContent(), /docs-site/);
    assert.match(await main.textContent(), /in the trash/);
    assert.match(await main.textContent(), /Their team/);
    assert.match(await main.textContent(), /any secret objects shared with you/);
    const remove = page.getByRole('button', { name: 'Delete 5 items for good' });
    assert.equal(await remove.isDisabled(), true);
    await page.getByLabel('Type your handle, sample-owner, to confirm').fill('sample-owne');
    assert.equal(await remove.isDisabled(), true);
    await page.getByLabel('Type your handle, sample-owner, to confirm').fill('sample-owner');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.deleted), 'asked');
    await context.close();
  }
  {
    // A person who owns nothing still reviews and leaves what is shared with them.
    const { page, context } = await open(1440, 'light', 'leave-only');
    const leave = page.getByRole('button', { name: 'Leave everything shared with you' });
    assert.equal(await leave.isDisabled(), true);
    await page.getByLabel('Type your handle, sample-owner, to confirm').fill('sample-owner');
    assert.equal(await leave.isDisabled(), false);
    await context.close();
  }
  for (const [data, button, mark] of [
    ['refused', 'Review again', 'over'],
    ['unanswered', 'Check again', 'retried'],
    ['pass-refused', 'Try again', 'retried'],
  ]) {
    // A refused or unanswered begin and a refused pass each say so and offer the one way on.
    const { page, context } = await open(390, 'light', data);
    assert.equal(await page.getByRole('alert').count(), 1, `${data}: one alert`);
    await page.getByRole('button', { name: button }).click();
    assert.equal(await page.evaluate(key => document.body.dataset[key], mark), 'yes', data);
    assert.doesNotMatch(
      await page.locator('main').textContent(),
      /Keep this page open/,
      `${data}: not shown as running`,
    );
    await context.close();
  }
  {
    const { page, context } = await open(1440, 'light', 'waiting');
    assert.match(
      await page.locator('main [role=status]').filter({ hasText: 'still running' }).textContent(),
      /still running; this page carries on/,
    );
    await context.close();
  }
  {
    // A long kind opens in place.
    const { page, context } = await open(1440, 'light', 'worst-review');
    assert.equal(await page.locator('.group .row').count(), 11);
    await page.getByRole('button', { name: 'Show all 50' }).click();
    assert.equal(await page.locator('.group .row').count(), 50);
    await context.close();
  }
  for (const data of ['sample', 'worst', 'empty', 'review', 'leave-only', 'refused', 'unanswered', 'waiting'])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, data);
        await check(page, `${data} ${width} ${theme}`);
        if (shots)
          await page.screenshot({ path: join(shots, `data-${data}-${width}-${theme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
      }
});
