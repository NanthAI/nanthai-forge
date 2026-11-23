// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The terms page (Item b6588425, lines 1 and 7): the acceptable-use section renders, names in-app reporting and the
// support@nanthai.tech abuse-report contact without keeping the placeholder, stays a draft, and passes axe with no
// sideways scroll at phone and desk width in both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { settleBrowserPage } from './browser-runtime.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Legal from ${JSON.stringify(join(root, 'web/src/app/Legal.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
createRoot(document.getElementById('root')).render(<Legal page="terms" />);
`;

test('terms: the acceptable-use section renders, the page stays a draft, and it passes axe at phone and desk width in both themes', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-terms-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Terms · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
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
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  for (const width of [390, 1440]) {
    for (const theme of ['light', 'dark']) {
      const label = `${width}px ${theme}`;
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
      await page.goto('https://forge.test/terms');
      await page.locator('main h1').first().waitFor();
      await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
      await settleBrowserPage(page);
      const section = page.locator('article h2', { hasText: 'Acceptable use and enforcement' });
      assert.equal(await section.count(), 1, `${label}: the section heading renders once`);
      const article = await page.locator('article').innerText();
      assert.match(article, /rate-limit, suspend or\s+remove your account/, label);
      assert.match(
        article,
        /Report abuse in the app where Report is available, or email support@nanthai\.tech\./,
        label,
      );
      assert.doesNotMatch(article, /A way to report abuse is coming/, label);
      assert.match(await page.locator('.intro').innerText(), /Draft draft-1, not legal advice/, label);
      const hrefs = await page
        .locator('article a')
        .evaluateAll(links => links.map(a => a.getAttribute('href')));
      assert.deepEqual(
        hrefs,
        ['mailto:support@nanthai.tech', '/signin', '/privacy'],
        `${label}: links the abuse-report contact, sign-in and privacy`,
      );
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
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  }
});
