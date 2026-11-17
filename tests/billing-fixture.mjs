// SPDX-License-Identifier: Apache-2.0
// Real billing components in the account frame, built once per test file with synthetic stub data and no session.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
export const shots = process.env.FORGE_BILLING_SHOTS;
const viewport = width => ({ width, height: width === 390 ? 844 : 1000 });

async function page(out) {
  const entry = 'virtual:billing-test';
  const source = `    import ${JSON.stringify(join(root, 'web/src/shell/mark.css'))};
    import ${JSON.stringify(join(root, 'web/src/ui/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ui/components.css'))};
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import Billing from ${JSON.stringify(join(root, 'web/src/billing/Home.tsx'))};
    import {AccountFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    createRoot(document.getElementById('root')).render(h(AccountFrame,{place:'billing',back:null,
      controls:{viewerHandle:'sample-owner',onPalette(){},onKeys(){}}},h(Billing)));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'billing-fixture',
        resolveId(id) {
          if (id === entry) return '\0billing-test.js';
        },
        load(id) {
          if (id === '\0billing-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('billing-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Billing · Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

/** Builds the fixture and returns `open(query, width, theme)`, or null when Chromium is not installed. */
export async function billingFixture(t) {
  if (!existsSync(chromium.executablePath())) return null;
  const out = mkdtempSync(join(tmpdir(), 'forge-billing-'));
  const html = await page(out);
  const browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
  const errors = [];
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'no runtime errors');
  });
  const open = async (query, width = 1440, theme = 'dark') => {
    const tab = await browser.newPage({ viewport: viewport(width) });
    t.after(() => tab.close());
    tab.on('pageerror', error => errors.push(error.message));
    await tab.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html';
      return route.fulfill({
        contentType: asset ? contentType : 'text/html',
        body: asset ? readFileSync(file) : html,
      });
    });
    await tab.goto(`https://forge.test/-/account/billing?${query}`);
    await tab.locator('h1').waitFor();
    await tab.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return tab;
  };
  return { open };
}

/** axe (with contrast) is clean and the page never scrolls sideways. */
export async function assertDrawn(tab, label) {
  await tab.evaluate(() => document.fonts.ready);
  await tab.addScriptTag({ path: axe });
  const violations = await tab.evaluate(async () =>
    (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations.map(v => ({
      id: v.id,
      nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })),
    })),
  );
  assert.deepEqual(violations, [], `${label}: axe`);
  assert(
    await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${label}: no horizontal page scroll`,
  );
}
