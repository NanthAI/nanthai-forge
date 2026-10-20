// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
test('Code labels and activity follow file selection; work-map counts use singular and plural', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const server = await createServer({
    root: `${root}/web`,
    configFile: false,
    logLevel: 'silent',
    cacheDir: `${root}/node_modules/.cache/qa-m-vite`,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    resolve: {
      alias: [{ find: /^convex\/react$/, replacement: `${root}/tests/fixtures/s1b-convex-react.mjs` }],
    },
    plugins: [
      {
        name: 'qa-m',
        configureServer(s) {
          s.middlewares.use('/fixture.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<html><head><title>Forge label QA</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/fixtures/qa-m-code.tsx"></script></body></html>`,
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}/fixture.html`;
    const output = process.env.FORGE_QA_SCREENSHOTS;
    if (output) mkdirSync(output, { recursive: true });
    for (const [width, theme] of [
      [1500, 'dark'],
      [390, 'light'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}?theme=${theme}`);
      // Code without a file selects the root README.md; there is no Changing now strip or empty pane.
      await page.getByLabel('Changing this file', { exact: true }).first().waitFor();
      assert.equal(await page.title(), 'Forge label QA');
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      assert.equal(await page.getByLabel('Changing now', { exact: true }).count(), 0);
      assert.equal(await page.locator('.code-file-path').innerText(), 'README.md');
      assert.equal(await page.locator('button[title="README.md"][aria-current="page"]').count(), 1);
      assert.equal(await page.getByText('Select a file').count(), 0);
      assert.equal(await page.locator('.code-main-pin').count(), 0);
      assert.match(await page.getByRole('button', { name: 'Source: main' }).innerText(), /main/);
      if (output)
        await page.screenshot({ path: `${output}/code-default-${width}-${theme}.png`, fullPage: true });
      // The collapsed src folder carries the dot of the Lane touching a file beneath it.
      assert.equal(await page.locator('.code-folder > summary .code-touched').count(), 1);
      // Up to 1059 px the tree lives behind `Files`; choosing a file closes the sheet.
      const narrow = width <= 1059;
      const tree = async () => {
        if (!narrow) return page.locator('.workspace > .sidebar');
        await page.locator('.code-files-btn').click();
        return page.locator('.fx-sheet');
      };
      let files = await tree();
      await files.locator('.code-folder > summary').click();
      await files.locator('button[title="src/export.ts"]').click();
      const changing = page.getByLabel('Changing this file', { exact: true });
      await changing.waitFor();
      assert.equal(await page.getByLabel('Changing now', { exact: true }).count(), 0);
      assert.equal(await changing.getByRole('link').count(), 1);
      assert.match(await changing.innerText(), /claude-exports/);
      assert.doesNotMatch(await changing.innerText(), /Explain exports/);
      await changing.getByText('L1', { exact: true }).waitFor();
      assert.match(
        await changing.getByRole('link').getAttribute('href'),
        /\/lanes\/exports\?.*diffFile=src%2Fexport\.ts/,
      );
      // The tree dot, the strip, the gutter mark and the This file panel agree on the same Lane.
      assert.equal(await page.locator('button[title="src/export.ts"] .code-touched').count(), 1);
      assert.equal(await page.locator('.source-pane .lane-touched-line').count(), 1);
      assert.equal(await page.locator('.code-this-file .code-lane-row').count(), 1);
      assert.match(await page.locator('.code-this-file .code-lane-row').innerText(), /Working[\s\S]*L1/);
      assert.match(await page.locator('.code-this-file .code-symbol').innerText(), /const\s*filename\s*L1/);
      assert.equal(await page.getByText('Imports', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Exact record', { exact: true }).count(), 0);
      const header = await page.locator('.code-file-h').boundingBox();
      assert.ok(header.x + header.width <= width, `file header ${header.x + header.width} > ${width}`);
      assert.equal(await page.locator('.code-files-btn').isVisible(), narrow);
      assert.equal(await page.locator('.workspace > .sidebar').isVisible(), !narrow);
      assert.equal(await page.locator('.fx-sheet').count(), 0);
      if (output)
        await page.screenshot({ path: `${output}/code-file-${width}-${theme}.png`, fullPage: true });
      files = await tree();
      await files.locator('button[title="src/untouched.ts"]').click();
      await page
        .locator('button[title="src/untouched.ts"][aria-current="page"]')
        .waitFor({ state: 'attached' });
      await page.locator('.code-file-path').filter({ hasText: 'untouched.ts' }).waitFor();
      assert.equal(await page.locator('.code-changing-strip, .code-lane-row, .lane-touched-line').count(), 0);
      await page.goto(`${base}?theme=${theme}&map=1`);
      await page.getByText('Work map', { exact: true }).waitFor();
      assert.equal(
        await page.locator('svg title').filter({ hasText: 'Export filenames · 1 save' }).count(),
        1,
      );
      assert.match(await page.locator('svg').textContent(), /Explain exports · 2 saves/);
      assert.doesNotMatch(await page.locator('svg').textContent(), /1 saves/);
      if (output)
        await page.screenshot({ path: `${output}/lane-work-map-${width}-${theme}.png`, fullPage: true });
    }
    // A saved Lane head in the URL keeps the same frame; only the Source picker changes.
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(`${base}?head=${'b'.repeat(64)}&sourceLane=exports&file=src/export.ts#L1`);
    const picker = page.getByRole('button', { name: 'Source: Export filenames' });
    await picker.waitFor();
    assert.equal(await page.locator('.hosted-code .sidebar').count(), 1);
    assert.equal(await page.locator('.code-file-path').innerText(), 'src/export.ts');
    assert.equal(await page.getByText('Saved source').count(), 0);
    await picker.click();
    const menu = page.getByRole('menu', { name: 'Source: Export filenames' });
    await menu.waitFor();
    assert.match(
      await menu.innerText(),
      /Open Lanes[\s\S]*Export filenames[\s\S]*Explain exports[\s\S]*Exact head/,
    );
    assert.equal(
      await menu
        .locator('[aria-current="true"]')
        .innerText()
        .then(text => /Export filenames/.test(text)),
      true,
    );
    await menu.getByPlaceholder('Paste a hash').fill('zz');
    await menu.getByPlaceholder('Paste a hash').press('Enter');
    await page.getByText('No save matches that hash.').waitFor();
    await menu.getByPlaceholder('Paste a hash').fill('cccccccc');
    await menu.getByPlaceholder('Paste a hash').press('Enter');
    await page.getByRole('button', { name: 'Source: Explain exports' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('head'), 'c'.repeat(64));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
