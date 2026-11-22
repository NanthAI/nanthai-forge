// SPDX-License-Identifier: Apache-2.0
// Account > People and teams as real components with synthetic rows (Item a841a76d): teams list members by handle,
// only the owner's teams offer Add and Remove, the empty state offers Start a team, and the list, the worst case and the
// empty page pass axe with no sideways scroll at desk and phone width in both themes. Set FORGE_PEOPLE_SHOTS to a folder
// to also save the screenshots.
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
const shots = process.env.FORGE_PEOPLE_SHOTS;

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PeopleView } from ${JSON.stringify(join(root, 'web/src/app/people/AccountPeople.tsx'))};
import { AccountFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const m = (handle, extra = {}) => ({ handle, you: false, owner: false, ...extra });
const sample = [
  { id: 't1', name: 'core-maintainers', role: 'owner', ownerHandle: 'sample-owner', more: false,
    members: [m('sample-owner', { you: true, owner: true, key: 'k0' }), m('sample-peer', { key: 'k1' }), m(null, { key: 'k2' })] },
  { id: 't2', name: 'docs', role: 'member', ownerHandle: 'sample-peer', more: false,
    members: [m('sample-peer', { owner: true }), m('sample-owner', { you: true })] },
];
const long = 'bartholomew-fitzgerald-the-third-of-the-northern-reaches-x';
const worst = [
  { ...sample[0], id: 'w1', name: 'a-very-long-team-name-that-keeps-going-well-past-any-sensible-width-for-one-row', more: true,
    members: Array.from({ length: 12 }, (_, i) => m(i ? long + i : 'sample-owner', { key: 'k' + i, you: !i, owner: !i })) },
  { ...sample[1], id: 'w2', name: 'م', ownerHandle: long, members: [m(long, { owner: true }), m('x', { you: true })] },
];
const mode = new URLSearchParams(location.search).get('data') || 'sample';
const read = mode === 'empty' ? { state: 'ok', data: { teams: [], more: false } }
  : { state: 'ok', data: { teams: mode === 'worst' ? worst : sample, more: mode === 'worst' } };
const actions = {
  create: async name => { document.body.dataset.created = name; },
  add: async (id, email) => { if (email === 'nobody@example.test') throw new Error('No Forge account currently matches that verified address.'); document.body.dataset.added = id + ':' + email; },
  remove: async (id, key) => { document.body.dataset.removed = id + ':' + key; },
};
createRoot(document.getElementById('root')).render(
  <AccountFrame place="people" back={null} controls={{ viewerHandle: 'sample-owner', onPalette() {}, onKeys() {} }}>
    <PeopleView read={read} retry={() => {}} showMore={() => { document.body.dataset.more = 'asked'; }} actions={actions} />
  </AccountFrame>,
);
`;

test('account people: teams by handle, owner-only controls, and every state passes axe', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-people-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>People and teams · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
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
    await page.goto(`https://forge.test/account?data=${data}`);
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
    assert.match(await main.locator('.head').textContent(), /2 teams: you own 1, you are in 1\./);
    assert.deepEqual(await main.locator('.row.team .ttl').allTextContents(), ['core-maintainers', 'docs']);
    assert.match(await main.locator('.row.team').nth(0).textContent(), /sample-peer/);
    assert.match(await main.locator('.row.team').nth(0).textContent(), /An account with no handle/);
    // Owner controls on the owner's team only; the owner is never offered for removal.
    assert.equal(
      await main
        .locator('.row.team')
        .nth(0)
        .getByRole('button', { name: /^Remove / })
        .count(),
      2,
    );
    assert.equal(
      await main
        .locator('.row.team')
        .nth(1)
        .getByRole('button', { name: /Remove|Add/ })
        .count(),
      0,
    );
    await page.getByRole('button', { name: 'Remove sample-peer from core-maintainers' }).click();
    assert.equal(await page.evaluate(() => document.body.dataset.removed), 't1:k1');
    const email = page.getByLabel('Add a member by their verified email');
    await email.fill('nobody@example.test');
    await email.press('Enter');
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /No Forge account currently matches/);
    await email.fill('peer@example.test');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.added);
    assert.equal(await page.evaluate(() => document.body.dataset.added), 't1:peer@example.test');
    assert.equal(await email.inputValue(), '', 'the field clears after a member is added');
    await page.getByLabel('Start a team').fill('reviewers');
    await page.getByLabel('Start a team').press('Enter');
    await page.waitForFunction(() => document.body.dataset.created);
    assert.equal(await page.evaluate(() => document.body.dataset.created), 'reviewers');
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context } = await open(390, 'light', 'worst');
    assert.match(await page.locator('main').textContent(), /2 shown; you are in more teams\./);
    assert.match(await page.locator('main').textContent(), /and more/);
    const more = page.getByRole('button', { name: 'Show 20 more' });
    await more.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.more), 'asked');
    await context.close();
  }
  {
    const { page, context } = await open(390, 'dark', 'empty');
    assert.match(await page.locator('main').textContent(), /No teams yet/);
    assert.equal(await page.getByLabel('Start a team').count(), 1);
    await context.close();
  }
  for (const data of ['sample', 'worst', 'empty'])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, data);
        await check(page, `${data} ${width} ${theme}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `people-${data}-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      }
});
