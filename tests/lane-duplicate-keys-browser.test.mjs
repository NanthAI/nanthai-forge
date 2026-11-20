// SPDX-License-Identifier: Apache-2.0
// Item f9309eec: the Lane page logged React "two children with the same key" for ids that repeat in its source rows.
// This mounts the hosted Lane page and the Lane review screen, each in a real browser on a fixture whose source data
// repeats a save head, an operation id, an accepted move and a file path, through a development React build (the
// production build never logs key warnings), and fails on any console error. 1440 px and 390 px both render the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"development"' },
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: { input: { fixture: join(root, 'tests/browser/lane-duplicate-keys.tsx') } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(
    item => item.isEntry && item.facadeModuleId?.endsWith('tests/browser/lane-duplicate-keys.tsx'),
  );
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Duplicate keys</title></head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('f9309eec: the Lane page and the review screen render repeated source rows without a duplicate-key error', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-lane-keys-'));
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  try {
    for (const [scenario, ready] of [
      ['lane', '.fx-lane-page'],
      ['review', 'section[aria-label="The change"]'],
    ])
      for (const viewport of [DESK, PHONE]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => message.type() === 'error' && errors.push(message.text()));
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.protocol === 'data:') return route.continue();
          if (url.hostname !== 'forge.test') return route.abort();
          if (url.pathname === '/keys.html') return route.fulfill({ contentType: 'text/html', body: html });
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
        await page.goto(`https://forge.test/keys.html?s=${scenario}`);
        await page
          .locator(ready)
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
        if (scenario === 'lane') {
          // Each repeated row is listed once.
          assert.equal(
            await page.locator('.fx-feed li', { hasText: 'Saved' }).count(),
            3,
            'three saves, one row each',
          );
          assert.equal(await page.locator('.fx-thread li').count(), 2, 'op-1 once, op-2 once');
        } else {
          assert.equal(await page.locator('.lr-file').count(), 3, 'src/a.ts once, then b and c');
        }
        await context.close();
        assert.deepEqual(errors, [], `${scenario} at ${viewport.width}: no console errors`);
      }
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
