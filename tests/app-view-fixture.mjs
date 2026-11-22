// SPDX-License-Identifier: Apache-2.0
// Builds a one-page fixture app around real screen components with synthetic props and serves it from a fake origin, so
// a browser test can open it at any width and theme and run axe on it. Shared by the Trash and Settings > Project tests.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { settleBrowserPage } from './browser-runtime.mjs';
const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL('../', import.meta.url));

/** The test browser's path, or null after skipping the test when none is installed. The test launches it itself. */
export function testBrowser(t) {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (existsSync(executablePath)) return executablePath;
  t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  return null;
}

/** `source` is the fixture's module text; it renders into #root and reads its state from the query string. */
export async function viewFixture(t, source, title, browser) {
  const temp = mkdtempSync(join(tmpdir(), 'forge-view-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>`,
  );
  writeFileSync(join(temp, 'fixture.tsx'), source);
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
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const open = async (width, theme, query, path = '/-/account') => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const asset = url.pathname.slice(1);
      const file = asset.startsWith('fonts/') ? join(root, 'web/public', asset) : join(out, asset);
      const found = asset && existsSync(file) && !file.endsWith('/');
      return route.fulfill({
        contentType: !found
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.woff2')
                ? 'font/woff2'
                : 'application/octet-stream',
        body: readFileSync(found ? file : join(out, 'fixture.html')),
      });
    });
    await page.goto(`https://forge.test${path}?${query}`);
    await page.locator('main h1').first().waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    await settleBrowserPage(page);
    return { page, errors, context };
  };
  /** No sideways scroll, and axe finds nothing at WCAG 2.1 AA. */
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
  return { open, check };
}
