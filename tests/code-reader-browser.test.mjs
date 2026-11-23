// SPDX-License-Identifier: Apache-2.0
// Item 8e847a17 in a real browser: the Pierre highlighter runs in the worker (WebAssembly, under the site's script
// policy) and colours a diff unified and side by side and the code in a rendered Markdown file; Markdown draws as a
// document with its raw HTML dropped, a relative link into the repository, and an image it cannot load said in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(out) {
  const entry = 'virtual:code-reader-test';
  const source = `
    import {createElement as h, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider} from 'convex/react';
    import {DiffView, DiffModeToggle} from ${JSON.stringify(join(root, 'web/src/diff-view.tsx'))};
    import MarkdownFile from ${JSON.stringify(join(root, 'web/src/app/code/MarkdownFile.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const noop = () => {};
    const client = {
      watchQuery: () => ({ onUpdate: () => noop, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: noop }),
      query: () => Promise.reject(new Error('no reads')),
      action: () => Promise.reject(Object.assign(new Error('refused'), { data: { message: 'refused' } })),
      mutation: () => Promise.reject(new Error('no writes')),
      logger: { warn: noop, log: noop, error: noop, logVerbose: noop },
      connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
      subscribeToConnectionState: () => noop,
    };
    const hunks = [{ beforeStart: 1, afterStart: 1, lines: [
      { kind: 'context', text: 'export const a = 1;' },
      { kind: 'removed', text: 'const old = "x";' },
      { kind: 'removed', text: 'const gone = 2;' },
      { kind: 'added', text: 'const next: string = "y";' },
      { kind: 'context', text: '// tail' },
    ] }];
    const md = ['# Title', '', '<script>window.pwned = 1</script>', '', 'See [the guide](docs/guide.md) and [out](https://example.com).', '', '![logo](assets/logo.png)', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '\`\`\`ts', 'const a: number = 1;', '\`\`\`'].join('\\n');
    function Root() {
      const [mode, setMode] = useState('unified');
      return h('div', null,
        h(DiffModeToggle, { mode, onChange: setMode }),
        h(DiffView, { path: 'src/a.ts', hunks, mode }),
        h(MarkdownFile, { text: md, source: { projectId: 'p1', state: 'a'.repeat(64), path: 'README.md', href: path => '/files/' + path } }));
    }
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client}, h(Root)));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'code-reader-fixture',
        resolveId(id) {
          if (id === entry) return '\0code-reader-test.js';
        },
        load(id) {
          if (id === '\0code-reader-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('code-reader-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><title>Forge</title>${styles}</head><body><main id="main"><div id="root"></div></main><script type="module" src="/${script}"></script></body></html>`;
}

test('a diff and a Markdown file are coloured by the worker highlighter, unified and split, with raw HTML dropped', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-code-reader-'));
  const html = await fixture(out);
  const browser = await chromium.launch(launchOptions);
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const view = await browser.newPage();
  const errors = [];
  view.on('pageerror', error => errors.push(error.message));
  await view.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'forge.test') return route.abort();
    const file = join(out, url.pathname.slice(1));
    const asset = url.pathname.startsWith('/assets/') && existsSync(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'font/woff2';
    return route.fulfill(
      asset ? { contentType: type, body: readFileSync(file) } : { contentType: 'text/html', body: html },
    );
  });
  await view.goto('https://forge.test/');

  const diff = view.getByRole('region', { name: 'Changes to src/a.ts' });
  await diff.locator('.kw').first().waitFor();
  assert.ok((await diff.locator('.str').count()) >= 1, 'strings are coloured in the unified diff');
  assert.equal(await diff.locator('.del').count(), 2);
  assert.equal(await diff.locator('.add').count(), 1);

  await view.getByRole('radio', { name: 'Split' }).click();
  const split = view.getByRole('region', { name: 'Changes to src/a.ts, side by side' });
  await split.locator('.kw').first().waitFor();
  const rows = await split
    .locator('.l:not(.hunk)')
    .evaluateAll(rows => rows.map(row => [...row.querySelectorAll('.c')].map(cell => cell.textContent)));
  assert.deepEqual(rows, [
    ['export const a = 1;', 'export const a = 1;'],
    ['const old = "x";', 'const next: string = "y";'],
    ['const gone = 2;', ''],
    ['// tail', '// tail'],
  ]);

  const doc = view.getByLabel('README.md');
  await doc.getByRole('heading', { name: 'Title' }).waitFor();
  assert.equal(await doc.locator('script').count(), 0);
  assert.equal(await view.evaluate(() => window.pwned), undefined, 'raw HTML in a README never runs');
  assert.equal(
    await doc.getByRole('link', { name: 'the guide' }).getAttribute('href'),
    '/files/docs/guide.md',
  );
  assert.equal(
    await doc.getByRole('link', { name: 'out' }).getAttribute('rel'),
    'noreferrer noopener nofollow ugc',
  );
  await doc.getByText('could not load').waitFor();
  assert.equal(await doc.locator('img').count(), 0);
  assert.equal(await doc.getByRole('cell', { name: '2' }).count(), 1, 'a GFM table draws');
  await doc.locator('pre .kw').first().waitFor();
  assert.deepEqual(errors, []);
});
