// SPDX-License-Identifier: Apache-2.0
// The top bar's main segment in a real browser (Item 32e8de50), through the real project frame on synthetic data
// (tests/browser/top-bar-main.tsx): with 0, 1 and 300 landings today it reads "main · N today · X% first try" on a
// desk (from 861 px, the narrowest top bar that holds the line) and "main · N · X%" on the phone's own line row,
// every word inside its cell and nothing clipped; its name starts with the words it shows; the page sets no
// repeating timer and makes no request; axe is clean with no sideways scroll at 1440, 1240, 1100, 1000, 861 and 390 px in both
// themes (top bar and phone line row; the rail has its own tests). Set FORGE_TOPBAR_SHOTS to a folder to also save the screenshots.
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
const shots = process.env.FORGE_TOPBAR_SHOTS || null;
const FIXTURE = 'tests/browser/top-bar-main.tsx';
const WIDTHS = [1440, 1240, 1100, 1000, 861, 390];

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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Top bar fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

const expected = {
  0: { desk: 'main · 0 today', phone: 'main · 0' },
  1: { desk: 'main · 1 today · 100% first try', phone: 'main · 1 · 100%' },
  300: { desk: 'main · 300 today · 87% first try', phone: 'main · 300 · 87%' },
};

test('the top bar main segment shows landings today and first-try share at every width, both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-top-bar-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark'])
      for (const land of [0, 1, 300])
        for (const width of WIDTHS)
          await t.test(`${land} landings at ${width} px, ${theme}`, async () => {
            const context = await browser.newContext({ viewport: { width, height: 800 } });
            await context.addInitScript(() => {
              // Any interval, or a timeout of a second or more still pending, would be the page waking itself up.
              window.intervals = 0;
              window.pending = new Set();
              const original = window.setInterval;
              window.setInterval = (...args) => {
                window.intervals++;
                return original(...args);
              };
              const later = window.setTimeout;
              const clear = window.clearTimeout;
              window.setTimeout = (run, ms, ...rest) => {
                const id = later(
                  (...a) => {
                    window.pending.delete(id);
                    return typeof run === 'function' ? run(...a) : undefined;
                  },
                  ms,
                  ...rest,
                );
                if (ms >= 1000) window.pending.add(id);
                return id;
              };
              window.clearTimeout = id => {
                window.pending.delete(id);
                return clear(id);
              };
            });
            const page = await context.newPage();
            const errors = [];
            const requests = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => message.type() === 'error' && errors.push(message.text()));
            await page.route('**/*', async route => {
              const url = new URL(route.request().url());
              if (url.protocol === 'data:') return route.continue();
              if (url.hostname !== 'forge.test') {
                requests.push(url.href);
                return route.abort();
              }
              if (url.pathname === '/top.html')
                return route.fulfill({ contentType: 'text/html', body: html });
              const file = join(out, url.pathname.slice(1));
              if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
              const contentType = file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : 'text/html';
              return route.fulfill({ contentType, body: readFileSync(file) });
            });
            try {
              await page.goto(`https://forge.test/top.html?land=${land}&theme=${theme}`);
              const phone = width < 861;
              const segment = page.locator(phone ? '.line.phone .tomain' : 'header.top .line .tomain');
              await segment.waitFor({ timeout: 10_000 });
              const seen = await segment.evaluate(link => {
                const cell = link.getBoundingClientRect();
                const parts = [...link.querySelectorAll('.g')].map(node => node.getBoundingClientRect());
                return {
                  text: link.textContent.replace(/\s+/g, ' ').trim(),
                  name: link.getAttribute('aria-label'),
                  visible: getComputedStyle(link).display !== 'none' && cell.width > 0,
                  inside: parts.every(
                    r =>
                      r.left >= cell.left - 0.5 &&
                      r.right <= cell.right + 0.5 &&
                      r.top >= cell.top - 0.5 &&
                      r.bottom <= cell.bottom + 0.5,
                  ),
                  clipped: [...link.querySelectorAll('.g')].some(
                    node => node.scrollWidth > node.clientWidth + 1,
                  ),
                  rows: new Set(parts.map(r => Math.round(r.top))).size,
                  line: Math.round(link.parentElement.getBoundingClientRect().width),
                  room: Math.round(cell.width - (Math.max(...parts.map(r => r.right)) - cell.left)),
                };
              });
              t.diagnostic(JSON.stringify({ land, width, theme, ...seen }));
              const want = expected[land][phone ? 'phone' : 'desk'];
              assert.ok(seen.visible, 'the segment is on screen');
              assert.equal(seen.text, want);
              assert.ok(seen.inside, `every word inside its cell: ${JSON.stringify(seen)}`);
              assert.ok(!seen.clipped, 'nothing cut off');
              assert.ok(
                seen.rows <= (phone ? 1 : 2),
                `at most ${phone ? 'one row' : 'two rows'}: ${seen.rows}`,
              );
              // The stops keep their words: "Ready to land" is not cut short to make room (861 px is the tightest).
              const cut = await page.evaluate(
                selector =>
                  [...document.querySelectorAll(`${selector} [data-stop] .lbl`)]
                    .filter(node => node.scrollWidth > node.clientWidth)
                    .map(node => node.textContent),
                phone ? '.line.phone' : 'header.top .line',
              );
              assert.deepEqual(cut, [], 'no stop word ellipsized');
              assert.ok(seen.name.startsWith(want), `"${seen.name}" starts with "${want}"`);
              assert.match(seen.name, /\(UTC day\)$/);
              const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
              assert.equal(sideways, false, 'no sideways scroll');
              await page.addScriptTag({ path: axePath });
              // The top bar and the phone's line row: the rail and page belong to their own tests.
              const axe = await page.evaluate(
                async phone =>
                  (
                    await window.axe.run(
                      { include: [phone ? '.line.phone' : 'header.top'] },
                      {
                        runOnly: {
                          type: 'tag',
                          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
                        },
                      },
                    )
                  ).violations,
                phone,
              );
              assert.deepEqual(
                axe.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
                [],
                'axe clean',
              );
              assert.equal(
                await page.evaluate(() => window.intervals + window.pending.size),
                0,
                'no repeating or long timer',
              );
              assert.deepEqual(requests, [], 'no request leaves the page');
              assert.deepEqual(errors, [], 'no page errors');
              if (shots)
                await page.screenshot({
                  path: join(shots, `top-bar-${land}-${width}-${theme}.png`),
                  clip: { x: 0, y: 0, width, height: phone ? 160 : 48 },
                });
            } finally {
              await context.close();
            }
          });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
