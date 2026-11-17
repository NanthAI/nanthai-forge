// SPDX-License-Identifier: Apache-2.0
// Needs me in a real browser (Items 3fa3187d, 0cb9b064), on synthetic data through its real view
// (tests/browser/needs-progress.tsx): Done is the all-time total with today beside it, a capped read shows "N+" on every
// figure, a withdrawn landing sits under FYI and out of the Needs you count; axe is clean with no sideways scroll
// at desk and phone width in both themes. Set FORGE_LANE_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_LANE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURE = 'tests/browser/needs-progress.tsx';

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { fixture: join(root, FIXTURE) } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(FIXTURE));
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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Needs me fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('Needs me: exact progress, N+ when capped, a withdrawn landing under FYI; axe and widths in both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-progress-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  async function open(t, viewport, query = '') {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/needs.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/needs.html${query}`);
    await page
      .locator('.ps')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  const standing = page =>
    page.locator('.ps').evaluateAll(nodes =>
      nodes.map(node =>
        [...node.childNodes]
          .map(child => child.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' '),
      ),
    );
  try {
    await t.test('exact figures, today beside Done, the withdrawal under FYI', async t => {
      const page = await open(t, DESK);
      const [done, inProgress, left] = await standing(page);
      assert.match(done, /^Done 579 Items · 12 today$/);
      assert.match(inProgress, /^In progress 57 Items/);
      assert.match(left, /^Left 237 Items · 8 proposed$/);
      // FYI is the quiet group of Item 48049998: the withdrawal is a row there, never counted in Needs you.
      assert.deepEqual(await page.getByText(/^Refused$/).allTextContents(), []);
      assert.match(
        await page.locator('section[aria-label="FYI"]').textContent(),
        /Site function for share cards: its agent withdrew the landing\./,
      );
      assert.doesNotMatch(
        await page.locator('section[aria-label="Needs you"]').textContent(),
        /Site function for share cards/,
      );
    });
    await t.test('a capped read: every figure reads N+', async t => {
      const page = await open(t, DESK, '?capped');
      const [done, inProgress, left] = await standing(page);
      assert.match(done, /^Done 200\+ Items$/);
      assert.match(inProgress, /^In progress 7\+ Items/);
      assert.match(left, /^Left 49\+ Items · 3\+ proposed$/);
    });
    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport);
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(
            scroll <= inner,
            `no sideways scroll at ${viewport.width} ${theme}: ${scroll} > ${inner}`,
          );
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(
              v =>
                `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
            );
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme}`);
          if (shots)
            await page.screenshot({
              path: join(shots, `needs-progress-${viewport.width}-${theme}.png`),
              fullPage: true,
            });
        }
      }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
