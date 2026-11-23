// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats for a reader (Item 157b3506): Stats is for project members with write access, so the read a reader or a
// signed-out visitor makes is refused (PROJECT_UNAVAILABLE / AUTH_REQUIRED). The real Stats place then shows the normal
// no-access notice inside the frame, and the rest of the app keeps working: the project nav is still there and another
// place opens. Axe passes at 1440 and 390 in both themes with no horizontal page scroll. A read that fails for any
// other reason shows a retry, not a blank app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const realConvex = join(root, 'node_modules/convex/dist/esm/react/index.js');

async function fixture(out) {
  const entry = 'virtual:stats-reader-test';
  // Every Convex read throws what the server throws for this fixture's account (set on the address: ?refuse=CODE).
  const convex = `
    export * from ${JSON.stringify(realConvex)};
    import {ConvexError} from 'convex/values';
    const messages = {PROJECT_UNAVAILABLE: 'Project membership is required to read full Work archives.', AUTH_REQUIRED: 'Sign in to see Stats.', HOSTED_ACTION_FAILED: 'The hosted request failed.'};
    export function useQuery() {
      const code = new URLSearchParams(location.search).get('refuse') ?? 'PROJECT_UNAVAILABLE';
      throw new ConvexError({code, message: messages[code]});
    }`;
  const source = `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider, ConvexReactClient} from 'convex/react';
    import Stats from ${JSON.stringify(join(root, 'web/src/app/stats/Stats.tsx'))};
    import {ProjectFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const client = new ConvexReactClient('https://forge.test.convex.cloud');
    const route = {frame: 'project', handle: 'example', project: 'tidepool', place: 'stats', section: '', rest: ''};
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client},
      h(ProjectFrame, {route, name: 'tidepool', projects: [], controls: {onPalette(){}, onKeys(){}, onPicker(){}, viewerHandle: 'reader'}},
        h(Stats, {route, projectId: 'p1', projectName: 'tidepool'}))));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'stats-reader-fixture',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === entry) return '\0stats-reader-test.js';
          if (id === 'convex/react' && importer !== '\0convex-react-stub.js') return '\0convex-react-stub.js';
        },
        load(id) {
          if (id === '\0stats-reader-test.js') return source;
          if (id === '\0convex-react-stub.js') return convex;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('stats-reader-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stats · tidepool · Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

test('stats: a reader gets the no-access notice in the frame and the rest of the app keeps working', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-stats-reader-'));
  const html = await fixture(out);
  const browser = await chromium.launch(launchOptions);
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (query = '', width = 1440, theme = 'dark') => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'font/woff2';
      return route.fulfill({
        contentType: asset ? type : 'text/html',
        body: asset ? readFileSync(file) : html,
      });
    });
    await page.goto(`https://forge.test/example/tidepool/stats${query}`);
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return page;
  };

  // A reader: the notice, in the frame, with the project nav still there and another place one click away.
  const reader = await open();
  await reader.locator('h1').waitFor();
  assert.match(await reader.locator('h1').textContent(), /Stats/);
  const notice = reader.getByRole('status').filter({ hasText: 'No access' });
  assert.match(
    await notice.textContent(),
    /Only signed-in project members with write access can see Stats\./,
  );
  assert.equal(await reader.getByRole('button', { name: 'Retry' }).count(), 0, 'a refusal is not retried');
  const nav = reader.getByRole('navigation', { name: 'Project' });
  assert((await nav.count()) >= 1, 'the frame still draws');
  await nav.getByRole('link', { name: 'Lanes' }).first().click();
  await reader.waitForURL(/\/example\/tidepool\/lanes/);
  await reader.locator('h1').waitFor();

  // A signed-out visitor gets the same notice; any other failure shows a retry, not a blank app.
  const visitor = await open('?refuse=AUTH_REQUIRED');
  await visitor.getByRole('status').filter({ hasText: 'No access' }).waitFor();
  const broken = await open('?refuse=HOSTED_ACTION_FAILED');
  await broken.getByRole('alert').filter({ hasText: 'The hosted request failed.' }).waitFor();
  assert.equal(await broken.getByRole('button', { name: 'Retry' }).count(), 1);

  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      const draw = await open('', width, theme);
      await draw.getByRole('status').filter({ hasText: 'No access' }).waitFor();
      await draw.evaluate(() => document.fonts.ready);
      await draw.addScriptTag({ path: axe });
      const violations = await draw.evaluate(async () =>
        (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations
          // The shared top-bar line's known finding; the shell Lane fixes it.
          .filter(v => v.id !== 'label-content-name-mismatch')
          .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })) })),
      );
      assert.deepEqual(violations, [], `${width}/${theme}: axe`);
      assert(
        await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}/${theme}: no horizontal page scroll`,
      );
    }
  assert.deepEqual(errors, []);
});
