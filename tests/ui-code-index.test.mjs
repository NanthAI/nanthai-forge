// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
test('Code lists indexed paths without full-source reads and reads only the default README.md', async t => {
  if (!existsSync(chromium.executablePath())) {
    t.skip(
      'Playwright Chromium is not installed in this clean check environment; run the browser fixture in the QA Lane.',
    );
    return;
  }
  const server = await createServer({
    root: `${root}/web`,
    configFile: false,
    cacheDir: `${root}/node_modules/.cache/k-code-index-vite`,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    resolve: {
      alias: [{ find: /^convex\/react$/, replacement: `${root}/tests/fixtures/s1b-convex-react.mjs` }],
    },
    plugins: [
      {
        name: 'code-index-test',
        configureServer(s) {
          for (const [path, entry] of [
            ['/lane.html', 'k-lane-source'],
            ['/critical.html', 'k-critical'],
          ])
            s.middlewares.use(path, (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(
                `<html><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/fixtures/${entry}.tsx"></script></body></html>`,
              );
            });
          s.middlewares.use('/fixture.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<html><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/fixtures/k-code-index.tsx"></script></body></html>`,
            );
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture.html`);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const file = page.getByRole('button', { name: 'README.md', exact: true });
    try {
      await file.waitFor({ timeout: 15000 });
    } catch {
      assert.fail(JSON.stringify({ errors, body: await page.locator('body').innerText() }));
    }
    // Code without a file selects the root README.md: one file read, no full-source read.
    await page.getByText('export const value = 1;', { exact: false }).first().waitFor();
    assert.equal(await file.getAttribute('aria-current'), 'page');
    const reads = await page.evaluate(() => globalThis.__codeReads);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].file, 'README.md');
    assert.equal(await page.evaluate(() => globalThis.__manifestReads), 0);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture.html?legacy=1`);
    await page.getByText('export const value = 1;', { exact: false }).first().waitFor();
    const legacyReads = await page.evaluate(() => globalThis.__codeReads);
    assert.equal(legacyReads.length, 1);
    assert.equal(legacyReads[0].file, 'README.md');
    assert.equal(await page.evaluate(() => globalThis.__manifestReads), 0);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/lane.html`);
    await page
      .getByText('This source object is not retained in the selected checkpoint.', { exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => globalThis.__sourceReads), 0);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/lane.html?legacy=1`);
    await page.getByText('No saved changes yet.', { exact: false }).first().waitFor();
    assert.equal(await page.evaluate(() => globalThis.__sourceReads), 1);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/critical.html`);
    await page.waitForFunction(() => window.__forgeCritical?.Now !== undefined);
    assert.equal(await page.evaluate(() => window.__forgeCritical.Now.complete), undefined);
    await page.evaluate(() => window.__criticalReady());
    await page.waitForFunction(() => window.__forgeCritical?.Now.complete !== undefined);
    const complete = await page.evaluate(() => window.__forgeCritical.Now.complete);
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.__presenceTick());
    assert.equal(await page.evaluate(() => window.__forgeCritical.Now.complete), complete);
  } finally {
    await browser?.close();
    await server.close();
  }
});
