// SPDX-License-Identifier: Apache-2.0
// Item e6f1290b in a real browser: where the page's own read says no check ran, one plain fact line sits beside
// Approve and land (no banner, no dialog, no extra step); with a check it is absent. Axe is clean with no sideways
// scroll at desk and phone width in both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FACT = 'No check ran yet; it will be checked before landing.';

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: { input: { fixture: join(root, 'tests/browser/landing-decision.tsx') } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(
    item => item.isEntry && item.facadeModuleId?.endsWith('tests/browser/landing-decision.tsx'),
  );
  const chunks = new Map(output.map(item => [item.fileName, item]));
  const css = new Set();
  const seen = new Set();
  const walk = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = chunks.get(name);
    for (const file of chunk?.viteMetadata?.importedCss ?? []) css.add(file);
    for (const next of [...(chunk?.imports ?? []), ...(chunk?.dynamicImports ?? [])]) walk(next);
  };
  walk(entry.fileName);
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Decision fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the no-check fact line beside Approve: plain text, no extra step, axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-landing-decision-'));
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/decision.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        contentType: file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
        body: readFileSync(file),
      });
    });
    await page.goto(`https://forge.test/decision.html?${query}`);
    await page.getByRole('button', { name: 'Approve and land' }).waitFor({ timeout: 10_000 });
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  try {
    for (const viewport of [DESK, PHONE]) {
      await t.test(`the line appears only when no check ran, at ${viewport.width}`, async t => {
        for (const [s, shown] of [
          ['unchecked', true],
          ['held', true],
          ['ready', false],
          ['held-checked', false],
        ]) {
          const page = await open(t, viewport, `s=${s}`);
          const line = page.getByText(FACT);
          assert.equal(await line.count(), shown ? 1 : 0, s);
          if (shown) {
            // Plain text beside the button, not a banner or dialog, and the button still acts at once.
            assert.equal(await page.getByRole('alert').count(), 0);
            assert.equal(await page.getByRole('dialog').count(), 0);
            assert.equal(await line.evaluate(node => node.tagName), 'P');
          }
        }
      });
      await t.test(`axe and widths at ${viewport.width}, both themes`, async t => {
        for (const s of ['unchecked', 'held']) {
          const page = await open(t, viewport, `s=${s}`);
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${s} ${theme}`);
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return result.violations.map(
                v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`,
              );
            });
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${s} ${theme}`);
          }
        }
      });
    }
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
