// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Shared Vite fixture build and static route/HTTP server helper for *-browser tests (Item 09961b44).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
export const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};

export function fixtureContentType(filePath, fallback = 'text/html') {
  const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || fallback;
}

export function fixturePageHtml({
  entry,
  css = [],
  title = 'Forge fixture',
  htmlAttrs = 'lang="en" data-ds data-theme="dark"',
  bodyStyle = '',
  bodyHtml = '<div id="root"></div>',
  headExtra = '',
}) {
  const styles = css.map(file => `<link rel="stylesheet" href="/${file}">`).join('');
  const attrs = htmlAttrs ? ` ${htmlAttrs}` : '';
  const bodyAttr = bodyStyle ? ` style="${bodyStyle}"` : '';
  return `<!doctype html><html${attrs}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${title}</title>${headExtra}${styles}</head><body${bodyAttr}>${bodyHtml}<script type="module" src="/${entry}"></script></body></html>`;
}

function walkEntryCss(output, entryFileName, dynamicImports = true) {
  const chunks = new Map(output.map(item => [item.fileName, item]));
  const css = new Set();
  const seen = new Set();
  const walk = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = chunks.get(name);
    for (const file of chunk?.viteMetadata?.importedCss ?? []) css.add(file);
    for (const next of [...(chunk?.imports ?? []), ...(dynamicImports ? (chunk?.dynamicImports ?? []) : [])])
      walk(next);
  };
  walk(entryFileName);
  return [...css];
}

/**
 * Build one (`entry`) or multiple (`entries`: `{ '/page.html': 'tests/browser/foo.tsx' }`) Vite fixture
 * entries against `web/vite.config.ts` in hosted mode and produce HTML page documents linking each
 * entry's imported CSS chunks.
 */
export async function buildBrowserFixture(
  out,
  {
    entry,
    entries,
    inputName = 'fixture',
    extraInputs,
    title = 'Forge fixture',
    htmlAttrs = 'lang="en" data-ds data-theme="dark"',
    bodyStyle = '',
    bodyHtml = '<div id="root"></div>',
    headExtra = '',
    css = true,
    dynamicImports = true,
    resolve: resolveConfig,
    define,
    plugins,
  },
) {
  assert(Boolean(entry) !== Boolean(entries), 'Pass exactly one of `entry` or `entries`.');
  const { build } = await import(pathToFileURL(join(repoRoot, 'node_modules/vite/dist/node/index.js')).href);
  const input = entries
    ? Object.fromEntries(
        Object.entries(entries).map(([url, file]) => [
          url.replace(/^\/+/, '').replace(/\.html$/, '') || 'fixture',
          resolve(repoRoot, file),
        ]),
      )
    : { [inputName]: resolve(repoRoot, entry) };
  if (extraInputs) Object.assign(input, extraInputs);
  const result = await build({
    configFile: join(repoRoot, 'web/vite.config.ts'),
    root: join(repoRoot, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    ...(resolveConfig ? { resolve: resolveConfig } : {}),
    ...(define ? { define } : {}),
    ...(plugins ? { plugins } : {}),
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const allCss =
    css === 'all' ? output.filter(item => item.fileName.endsWith('.css')).map(item => item.fileName) : null;

  const describeEntry = file => {
    const fullPath = resolve(repoRoot, file);
    const chunk = output.find(
      item => item.isEntry && (item.facadeModuleId === fullPath || item.facadeModuleId?.endsWith(file)),
    );
    assert(chunk, `Vite fixture build produced no entry chunk for ${file}`);
    const cssFiles =
      css === false ? [] : allCss ? allCss : walkEntryCss(output, chunk.fileName, dynamicImports);
    const page = (overrides = {}) =>
      fixturePageHtml({
        entry: chunk.fileName,
        css: cssFiles,
        title,
        htmlAttrs,
        bodyStyle,
        bodyHtml,
        headExtra,
        ...overrides,
      });
    return { entry: chunk.fileName, css: cssFiles, html: page(), page };
  };

  if (entry) return { out, ...describeEntry(entry) };
  const builtEntries = Object.fromEntries(
    Object.entries(entries).map(([url, file]) => [url, describeEntry(file)]),
  );
  const pages = Object.fromEntries(Object.entries(builtEntries).map(([url, info]) => [url, info.html]));
  return { out, entries: builtEntries, pages };
}

function readContainedFile(baseDir, relPath, fallbackType) {
  const base = resolve(baseDir);
  const file = resolve(base, relPath.replace(/^\/+/, ''));
  if (file !== base && !file.startsWith(base + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return { contentType: fixtureContentType(file, fallbackType), body: readFileSync(file) };
}

export function readFixtureAsset(out, pathname, { publicFonts = false, fallbackType = 'text/html' } = {}) {
  if (publicFonts && pathname.startsWith('/fonts/'))
    return readContainedFile(join(repoRoot, 'web/public'), pathname, fallbackType);
  return readContainedFile(out, pathname, fallbackType);
}

function resolveFixtureHtml(htmlOrPages, url, { paths, matchHtml } = {}) {
  if (typeof htmlOrPages === 'function') return htmlOrPages(url) ?? null;
  if (typeof htmlOrPages === 'string') {
    if (matchHtml) return matchHtml(url) ? htmlOrPages : null;
    if (paths) return (Array.isArray(paths) ? paths : [paths]).includes(url.pathname) ? htmlOrPages : null;
    return url.pathname === '/' ? htmlOrPages : null;
  }
  if (htmlOrPages && typeof htmlOrPages === 'object')
    return Object.hasOwn(htmlOrPages, url.pathname) ? htmlOrPages[url.pathname] : null;
  return null;
}

/**
 * Fulfill Playwright requests on `hostname` (`forge.test`) from the built fixture HTML and static assets in `out`.
 * Aborts requests to other origins (after optional `onExternal`) and lets `data:` URLs continue.
 */
export async function routeBrowserFixture(
  page,
  out,
  htmlOrPages,
  {
    hostname = 'forge.test',
    paths,
    matchHtml,
    handle,
    onExternal,
    publicFonts = false,
    fallbackType = 'text/html',
  } = {},
) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:') return route.continue();
    if (handle && (await handle(route, url))) return;
    if (url.hostname !== hostname) {
      onExternal?.(url);
      return route.abort();
    }
    const html = resolveFixtureHtml(htmlOrPages, url, { paths, matchHtml });
    if (html !== null) return route.fulfill({ contentType: 'text/html', body: html });
    const asset = readFixtureAsset(out, url.pathname, { publicFonts, fallbackType });
    if (!asset) return route.fulfill({ status: 404, body: '' });
    return route.fulfill(asset);
  });
}

/**
 * Start a loopback static HTTP server (`127.0.0.1:0`) serving the built fixture HTML and assets in `out`.
 */
export async function serveBrowserFixture(
  out,
  htmlOrPages,
  { paths, matchHtml, publicFonts = false, fallbackType = 'text/html' } = {},
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const html = resolveFixtureHtml(htmlOrPages, url, { paths, matchHtml });
    if (html !== null) {
      response.setHeader('content-type', 'text/html');
      return response.end(html);
    }
    const asset = readFixtureAsset(out, url.pathname, { publicFonts, fallbackType });
    if (!asset) return response.writeHead(404).end();
    response.setHeader('content-type', asset.contentType);
    return response.end(asset.body);
  }).listen(0, '127.0.0.1');
  await new Promise(resolveListen => server.once('listening', resolveListen));
  const { port } = server.address();
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolveClose => server.close(() => resolveClose())),
  };
}
