// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(root, 'tests/browser/ds-screens.tsx');

export async function buildFixture(out) {
  const { build } = await import('vite');
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: { input: { ds: join(root, 'web/ds.html'), screens: fixture } },
    },
  });
  const { output } = Array.isArray(result) ? result[0] : result;
  const entry = output.find(chunk => chunk.isEntry && chunk.facadeModuleId === fixture);
  const chunks = new Map(output.map(chunk => [chunk.fileName, chunk]));
  const css = new Set();
  const visited = new Set();
  function includeStyles(chunk) {
    if (!chunk || visited.has(chunk.fileName)) return;
    visited.add(chunk.fileName);
    for (const file of chunk.viteMetadata.importedCss) css.add(file);
    for (const name of chunk.imports) includeStyles(chunks.get(name));
  }
  includeStyles(entry);
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Forge reflow fixture</title><style>body { margin: 0 }</style>
    ${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
    </head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

const types = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.woff2': 'font/woff2',
};

export function fixtureResponse(out, html, path) {
  const ext = path.match(/\.[a-z0-9]+$/)?.[0];
  const file = join(path.startsWith('/fonts/') ? join(root, 'web/public') : out, path);
  if (!ext) return { contentType: 'text/html', body: html };
  if (!existsSync(file)) return { status: 404, body: '' };
  return { contentType: types[ext] ?? 'application/octet-stream', body: readFileSync(file) };
}

export async function serveFixture(page, out, html, path) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'forge.test') return route.abort();
    return route.fulfill(fixtureResponse(out, html, url.pathname));
  });
  await page.goto(`https://forge.test${path}`);
}
