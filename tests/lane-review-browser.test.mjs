// SPDX-License-Identifier: Apache-2.0
// The Lane review screen in a real browser (Items 52235fbf, 4bc460aa, a1e3d771), on synthetic data through its real
// components (tests/browser/lane-review.tsx). Files are grouped by what needs eyes with an observed reason each, file
// order is one press away, a folded file reads nothing and an opened one makes only its own download calls, read ticks
// reconcile with the count, a combined file shows where each line came from, and axe is clean with no sideways scroll
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

/** Build the fixture module as a page script; the page itself is written here (an HTML input outside web/ cannot be
 * emitted), linking every stylesheet the build produced. */
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
      rolldownOptions: {
        input: { fixture: join(root, 'tests/browser/lane-review.tsx') },
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  // The config adds its own pages' entries; the fixture's is the one built from its module.
  const entry = output.find(
    item => item.isEntry && item.facadeModuleId?.endsWith('tests/browser/lane-review.tsx'),
  );
  // Only the stylesheets the fixture's own chunks import: the other pages' (legacy) styles must not leak in.
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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Lane review fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the Lane review screen: order, lazy bodies, ticks, line origin, axe and widths in both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-lane-review-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  async function open(t, viewport, query) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    page.on('requestfailed', request => errors.push(`failed ${request.url().slice(0, 80)}`));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/lane-review.html')
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
    await page.goto(`https://forge.test/lane-review.html?${query}`);
    await page
      .locator('section[aria-label="The change"]')
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  const calls = page => page.evaluate(() => window.__calls?.length ?? 0);
  const bands = page =>
    page
      .locator('section[aria-label="The change"] .band')
      .evaluateAll(nodes =>
        nodes.map(node => [
          node.querySelector('span')?.textContent,
          Number(node.querySelector('.cnt')?.textContent),
        ]),
      );
  const shot = async (page, name) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };

  try {
    await t.test(
      'grouped by what needs eyes, with reasons; file order one press away; counts reconcile',
      async t => {
        const page = await open(t, DESK, 's=review');
        assert.deepEqual(await bands(page), [
          ['Needs your eyes', 14],
          ['Tests', 1],
          ['Low risk', 2],
        ]);
        const first = page.locator('.lr-file').first();
        assert.match(await first.locator('.path').textContent(), /src\/parser\/stream-parser\.ts/);
        assert.match(await first.locator('.why').textContent(), /same lines as sample-two\/salt-wren, 22-24/);
        assert.match(await page.locator('.lr-file').nth(1).locator('.why').textContent(), /a protected path/);
        // 8 drawn in the first band, the rest one press away; the band's count is the whole group.
        assert.equal(await page.locator('.lr-more').first().textContent(), 'Show 6 more');
        await page.locator('.lr-more').first().click();
        assert.equal(await page.locator('.lr-file').count(), 17);
        // Friction e2f436b6: held, but Needs me has not said it waits on this reader, so never "Held for you".
        assert.match(await page.locator('.head .sit').textContent(), /Held\. 14 of 17 files need your eyes/);
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        const paths = await page.locator('.lr-file .path').allTextContents();
        assert.deepEqual(paths, [...paths].sort());
        assert.equal(await calls(page), 0, 'nothing read for folded files');
      },
    );

    await t.test('an opened file reads only its own bytes; large files are named, not fetched', async t => {
      const page = await open(t, DESK, 's=review');
      await page.locator('.lr-file').first().locator('summary').click();
      await page.locator('.lr-file').first().locator('.code .l.add').first().waitFor();
      assert.deepEqual(await page.evaluate(() => window.__calls), [
        'projectObjectDownloads:describe',
        'projectObjectDownloads:describe',
      ]);
      await page.locator('.lr-more').first().click();
      const large = page.locator('.lr-file', { hasText: 'src/generated/tables.ts' });
      await large.locator('summary').click();
      await large.getByText(/Too long to draw here/).waitFor();
      assert.equal(await calls(page), 3, 'one describe names the size; no bytes for a file over the limit');
      // Reading ticks the file; the count beside the list reconciles.
      await page.getByRole('button', { name: 'Read src/parser/stream-parser.ts' }).click();
      assert.match(
        await page.locator('section[aria-label="The change"] .ph .hint').textContent(),
        /^1 of 17 files read$/,
      );
      assert.match(
        await page.locator('.cmd').first().textContent(),
        /^nforge agent \. sync '\{"laneId":.*"predecessor":\{/,
      );
      await shot(page, 'lane-review-open-1440-dark');
    });

    await t.test('a combined file says where each line came from, and that it is provisional', async t => {
      const page = await open(t, DESK, 's=combined');
      await page.getByText('Provisional').waitFor();
      await page.locator('.lr-more').first().click();
      const file = page.locator('.lr-file', { hasText: 'src/parser/stream-parser.ts' });
      await file.locator('summary').click();
      await file.getByRole('button', { name: 'Where lines came from' }).click();
      await file.locator('.tally').waitFor();
      assert.equal(
        (await file.locator('.tally').textContent()).replace(/\s+/g, ' '),
        '2 lines from sample-two/salt-wren1 from this Lane38 from main1 of sample-two/salt-wren’s left out',
      );
      assert.equal(
        await file.locator('.code.by .l.gone').count(),
        3,
        'two main lines replaced, one left out',
      );
      await shot(page, 'lane-review-origin-1440-dark');
    });

    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE])
        for (const s of ['review', 'combined']) {
          const page = await open(t, viewport, `s=${s}`);
          await page.locator('.lr-file').first().locator('summary').click();
          await page.locator('.lr-file').first().locator('.code').first().waitFor();
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(
              scroll <= inner,
              `no sideways scroll at ${viewport.width} ${s} ${theme}: ${scroll} > ${inner}`,
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
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${s} ${theme}`);
            await shot(page, `lane-review-${s}-${viewport.width}-${theme}`);
          }
        }
    });

    await t.test('phone width holds with a wider fallback font (Linux CI metrics)', async t => {
      // 1dd4e095: Linux's fallback glyphs are wider than macOS's; the recommendation header once overflowed to 398 px.
      const page = await open(t, PHONE, 's=review');
      await page.addStyleTag({ content: '* { font-family: Verdana, monospace !important; }' });
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      assert.ok(
        scroll <= inner,
        `no sideways scroll at ${PHONE.width} with a wide font: ${scroll} > ${inner}`,
      );
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
