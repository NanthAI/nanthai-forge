// SPDX-License-Identifier: Apache-2.0
// Item bd24f0a6: the real import screen says what comes across and what stays on GitHub, suggests the agent route for
// issues, and is accessible at 390 and 1440 in both themes.
import test from 'node:test';
import { settleBrowserPage } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_IMPORT_SCOPE_SHOTS;

test('the import screen names what stays on GitHub, offers the agent route for issues, and passes axe at both widths in both themes', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-import-scope-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  const shim = join(temp, 'convex.ts');
  const real = join(root, 'node_modules/convex/dist/esm/react/index.js');
  writeFileSync(
    shim,
    `export * from ${JSON.stringify(real)};
    export function useConvex() { return window.client; }
    export function useQuery() { return undefined; }
  `,
  );
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Import · Forge</title></head><body><main id="root"></main><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import ImportRepository from ${JSON.stringify(join(root, 'web/src/app/start/ImportRepository.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/base.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/core.css'))};
    window.calls = [];
    window.client = {
      query: async () => null,
      mutation: async () => null,
      action: async (ref, args) => { window.calls.push(args); return { repository: 'example/parser', origin: 'public', choices: ['public', 'private'], ref: 'main', commit: 'c'.repeat(40), files: 2914, bytes: 8300000, submodules: 0, attributes: 0, lfs: 'No .gitattributes, so no Git LFS files.', warnings: [], githubRequests: {} }; },
    };
    createRoot(document.getElementById('root')).render(<ImportRepository />);
  `,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^convex\/react$/, replacement: shim },
        { find: /^react\//, replacement: dirname(require.resolve('react/package.json')) + '/' },
        { find: /^react$/, replacement: dirname(require.resolve('react/package.json')) },
        { find: /^react-dom\//, replacement: dirname(require.resolve('react-dom/package.json')) + '/' },
        { find: /^convex\/server$/, replacement: join(root, 'node_modules/convex/dist/esm/server/index.js') },
      ],
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'forge.test') return route.abort();
    const path = url.pathname.slice(1);
    const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
    const asset = path && existsSync(file);
    return route.fulfill({
      contentType: !asset
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      body: readFileSync(asset ? file : join(out, 'fixture.html')),
    });
  });
  await page.goto('https://forge.test/-/new/import');
  await page.getByLabel('Address').fill('https://github.com/example/parser');
  await page.getByRole('button', { name: 'Check it' }).click();
  const region = page.locator('main');
  await region.getByText('Issues, pull requests, people and tags stay on GitHub').waitFor();
  const text = await region.textContent();
  assert.match(text, /Stays on GitHub/);
  assert.match(text, /The full history/);
  assert.match(text, /Issues, pull requests, people and tags stay on GitHub/);
  assert.match(text, /CI config comes with the source and keeps working with your own CI/);
  assert.doesNotMatch(text, /import(ing)? (your )?issues/i, 'no GitHub issue import is promised');
  const peek = region.locator('details', { hasText: 'Your issues' });
  assert.equal(
    await peek.evaluate(e => e.open),
    false,
    'the agent route sits behind a disclosure, not a banner',
  );
  await peek.locator('summary').click();
  assert.match(
    await peek.textContent(),
    /ask an agent to triage the ones worth keeping and recreate them as Items/,
  );
  assert.equal(
    await peek.getByRole('link', { name: 'How an agent does it' }).getAttribute('href'),
    '/docs/planning/#recipe-recreate-past-milestones-then-plan-the-next-one',
  );
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
      await settleBrowserPage(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const result = await page.evaluate(() =>
        window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
      );
      assert.deepEqual(
        result.violations.map(v => ({
          id: v.id,
          targets: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })),
        })),
        [],
      );
      if (shots)
        await page.screenshot({ path: join(shots, `import-scope-${width}-${theme}.png`), fullPage: true });
    }
  assert.deepEqual(errors, []);
});
