// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Projects as real components with synthetic rows (Items 3d5d8839, a0cf8c22): the held project is the one
// first stop, every row links to its project, the empty state gives one line with a copyable agent-led onboarding
// prompt and setup link plus the manual setup guide, and the list, the worst case and the empty page pass axe with no
// sideways scroll at desk and phone width in both themes. Set FORGE_PROJECTS_SHOTS to a folder to also save the
// screenshots.
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
const shots = process.env.FORGE_PROJECTS_SHOTS;

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectsView } from ${JSON.stringify(join(root, 'web/src/app/projects/Projects.tsx'))};
import { AccountFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const now = Date.parse('2026-11-17T12:00:00Z');
const c = (n, atLeast = false) => ({ n, atLeast });
const h = 3600000;
const sample = [
  { id: 'p1', name: 'stream-parser', handle: 'sample-owner', slug: 'stream-parser', role: 'owner', visibility: 'public', activityAt: now - 20 * 60000,
    held: c(2), lanes: c(7), main: { at: now - 40 * 60000, passing: true }, items: { done: c(31), inProgress: c(4), left: c(267) } },
  { id: 'p2', name: 'docs-site', handle: 'sample-owner', slug: 'docs-site', role: 'owner', visibility: 'private', activityAt: now - 3 * h,
    held: c(0), lanes: c(1), main: { at: now - 3 * h, passing: false }, items: { done: c(12), inProgress: c(1), left: c(5) } },
  { id: 'p3', name: 'shared-tools', handle: 'sample-peer', slug: 'shared-tools', role: 'write', visibility: 'private', activityAt: now - 30 * h,
    held: c(0), lanes: c(0), main: null, items: null },
  { id: 'p4', name: 'reading-room', handle: 'sample-peer', slug: 'reading-room', role: 'read', visibility: 'public', activityAt: now - 80 * h,
    held: c(0), lanes: c(0), main: { at: now - 80 * h, passing: true }, items: { done: c(0), inProgress: c(0), left: c(0) } },
];
const long = 'bartholomew-fitzgerald-the-third-of-the-northern-reaches-x';
const worst = [
  { ...sample[0], id: 'w1', name: 'a-very-long-project-name-that-keeps-going-well-past-any-sensible-width-for-a-row', handle: long, slug: 'a-very-long-project-name-that-keeps-going-well-past-any-sensible-width-for-a-row', held: c(20, true), lanes: c(60, true), items: { done: c(1000), inProgress: c(500, true), left: c(2048, true) } },
  { ...sample[1], id: 'w2', name: 'م', handle: 'x', slug: 'م', held: c(1) },
  { ...sample[2], id: 'w3', name: 'x', slug: 'x' },
];
const mode = new URLSearchParams(location.search).get('data') || 'sample';
const read = mode === 'empty' ? { state: 'ok', data: { projects: [], more: false } }
  : { state: 'ok', data: { projects: mode === 'worst' ? worst : sample, more: mode === 'worst' } };
createRoot(document.getElementById('root')).render(
  <AccountFrame place="projects" back={null} controls={{ viewerHandle: 'sample-owner', onPalette() {}, onKeys() {} }}>
    <ProjectsView read={read} retry={() => {}} showMore={() => { document.body.dataset.more = 'asked'; }} now={now} />
  </AccountFrame>,
);
`;

test('account projects: the held project leads, rows link to projects, and every state passes axe', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-projects-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Projects · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
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
    assert.match(
      await main.locator('.head').textContent(),
      /2 held Lanes need you, in stream-parser\. 4 projects\./,
    );
    const names = await main.locator('.row.proj .ttl').allTextContents();
    assert.deepEqual(names, ['stream-parser', 'docs-site', 'shared-tools', 'reading-room']);
    assert.equal(
      await main.locator('[data-weight="act"].row').count(),
      1,
      'one held project is the first stop',
    );
    assert.equal(
      await page.getByRole('link', { name: 'stream-parser', exact: true }).getAttribute('href'),
      '/sample-owner/stream-parser',
    );
    assert.equal(await page.getByRole('link', { name: 'Start a project' }).getAttribute('href'), '/new');
    assert.equal(
      await page.getByRole('link', { name: 'Import a repository' }).getAttribute('href'),
      '/new/import',
    );
    assert.match(await main.textContent(), /Items not reported/);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    // More rows behind the cursor: the page says how many are shown and the next page is one keyboard press away.
    const { page, context } = await open(390, 'light', 'worst');
    assert.match(await page.locator('main').textContent(), /3 shown; you have more projects\./);
    const more = page.getByRole('button', { name: 'Show 50 more' });
    await more.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.more), 'asked');
    await context.close();
  }
  {
    // Empty Projects page (Item a0cf8c22, Owner 2026-11-23): one line, copyable prompt + setup link, manual guide, no wizard.
    const { page, errors, context } = await open(390, 'dark', 'empty');
    const main = page.locator('main');
    assert.match(await main.textContent(), /No projects yet\./);
    assert.match(
      await main.textContent(),
      /Your projects appear here\. Paste this into your agent to set Forge up\./,
    );
    const promptRegion = main.getByRole('region', { name: 'Paste this into your agent' });
    const promptText = await promptRegion.locator('pre').textContent();
    assert.equal(
      promptText.split('\n')[0],
      'Read First landing in https://forge.test/docs/quickstart.md#first-landing',
    );
    assert.match(promptText, /`nforge login 'https:\/\/forge\.test'`/);
    assert.match(promptText, /nforge import OWNER\/REPO --site 'https:\/\/forge\.test'/);
    assert.match(promptText, /nforge host FOLDER --site 'https:\/\/forge\.test'/);
    assert.match(promptText, /clone the full project URL/);
    assert.doesNotMatch(promptText, /--deployment/);
    assert.match(promptText, /nforge connect <app>/);
    // Fallback when navigator.clipboard is missing (non-HTTPS / restricted webview), announced in a status live region.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });
    const copyButton = page.getByRole('button', { name: 'Copy prompt' });
    assert.equal(await copyButton.getAttribute('aria-live'), null, 'aria-live lives on a status region');
    await copyButton.click();
    await page.getByRole('button', { name: 'Select the text to copy' }).waitFor();
    assert.equal(
      await main.locator('[role="status"][aria-live="polite"]').textContent(),
      'Select the text to copy',
    );
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async text => {
            window.__copied = text;
          },
        },
      });
    });
    await page.getByRole('button', { name: 'Select the text to copy' }).click();
    await page.getByRole('button', { name: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => window.__copied), promptText);
    assert.equal(await main.locator('[role="status"][aria-live="polite"]').textContent(), 'Copied');
    const guideLink = page.getByRole('link', { name: 'Open /docs/quickstart.md' });
    const manualLink = page.getByRole('link', { name: 'Manual setup guide' });
    assert.equal(await guideLink.getAttribute('href'), '/docs/quickstart.md');
    assert.equal(await manualLink.getAttribute('href'), '/docs/quickstart/#first-landing');
    assert.ok((await guideLink.boundingBox()).height >= 40, 'phone touch target >= 40 px for agent link');
    assert.ok((await manualLink.boundingBox()).height >= 40, 'phone touch target >= 40 px for manual link');
    assert.equal(await page.getByRole('link', { name: 'Start a project' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Trash' }).getAttribute('href'), '/account?view=trash');
    assert.deepEqual(errors, []);
    await context.close();
  }
  for (const data of ['sample', 'worst', 'empty'])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, data);
        await check(page, `${data} ${width} ${theme}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `projects-${data}-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      }
});
