// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Contract tests for the shared Vite fixture build and static server/router helper (Item 09961b44, friction 87e5d6c7).
// Tests buildBrowserFixture's Vite config wiring and CSS walk with a synthetic bundler stub, and serve/route on a tiny
// static temp fixture, so this contract test never pays ~25 s for its own Vite builds (real Vite builds run in the browser shard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBrowserFixture,
  fixtureContentType,
  fixturePageHtml,
  readFixtureAsset,
  repoRoot,
  routeBrowserFixture,
  serveBrowserFixture,
} from './browser-fixture.mjs';

test('09961b44: buildBrowserFixture wires Vite config, walks entry CSS and builds page HTML without running Vite', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-browser-fixture-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const seenConfigs = [];
  const stubBuild = async config => {
    seenConfigs.push(config);
    return {
      output: [
        {
          isEntry: true,
          fileName: 'assets/fixture-1.js',
          facadeModuleId: resolve(repoRoot, 'tests/browser/setting-change.tsx'),
          viteMetadata: { importedCss: new Set(['assets/entry.css']) },
          imports: ['assets/shared.js'],
          dynamicImports: ['assets/lazy.js'],
        },
        {
          isEntry: false,
          fileName: 'assets/shared.js',
          viteMetadata: { importedCss: new Set(['assets/shared.css']) },
          // Cycle back to entry must terminate cleanly.
          imports: ['assets/fixture-1.js'],
          dynamicImports: [],
        },
        {
          isEntry: false,
          fileName: 'assets/lazy.js',
          viteMetadata: { importedCss: new Set(['assets/lazy.css']) },
          imports: [],
          dynamicImports: [],
        },
        {
          isEntry: false,
          fileName: 'assets/unrelated.css',
        },
      ],
    };
  };

  const built = await buildBrowserFixture(out, {
    entry: 'tests/browser/setting-change.tsx',
    title: 'Settings change fixture',
    bodyStyle: 'margin:0',
    build: stubBuild,
  });
  assert.equal(seenConfigs.length, 1);
  assert.equal(seenConfigs[0].configFile, join(repoRoot, 'web/vite.config.ts'));
  assert.equal(seenConfigs[0].root, join(repoRoot, 'web'));
  assert.equal(seenConfigs[0].mode, 'hosted');
  assert.equal(seenConfigs[0].build.outDir, out);
  assert.deepEqual(seenConfigs[0].build.rolldownOptions.input, {
    fixture: resolve(repoRoot, 'tests/browser/setting-change.tsx'),
  });
  assert.equal(built.entry, 'assets/fixture-1.js');
  assert.deepEqual(built.css, ['assets/entry.css', 'assets/shared.css', 'assets/lazy.css']);
  assert.match(built.html, /<title>Settings change fixture<\/title>/);
  assert.match(built.html, /<body style="margin:0">/);
  assert.match(built.html, /href="\/assets\/entry\.css"/);
  assert.match(built.html, /href="\/assets\/lazy\.css"/);
  assert.doesNotMatch(built.html, /unrelated\.css/);
  const noDs = built.page({ htmlAttrs: 'lang="en" data-theme="dark"' });
  assert.doesNotMatch(noDs, /\bdata-ds\b/);
  assert.match(built.html, /\bdata-ds\b/);

  // dynamicImports: false skips lazy CSS; css: 'all' includes every emitted stylesheet.
  const noDynamic = await buildBrowserFixture(out, {
    entry: 'tests/browser/setting-change.tsx',
    dynamicImports: false,
    build: stubBuild,
  });
  assert.deepEqual(noDynamic.css, ['assets/entry.css', 'assets/shared.css']);

  const allCss = await buildBrowserFixture(out, {
    entry: 'tests/browser/setting-change.tsx',
    css: 'all',
    build: stubBuild,
  });
  assert.deepEqual(allCss.css, ['assets/unrelated.css']);

  // Multi-entry map with css disabled and define passthrough.
  const multiConfigs = [];
  const multi = await buildBrowserFixture(out, {
    entries: { '/keys.html': 'tests/browser/lane-duplicate-keys.tsx' },
    extraInputs: { extra: resolve(repoRoot, 'web/src/ds/behaviour/index.ts') },
    title: 'Duplicate keys',
    htmlAttrs: 'lang="en"',
    css: false,
    define: { 'process.env.NODE_ENV': '"development"' },
    build: async config => {
      multiConfigs.push(config);
      return [
        {
          output: [
            {
              isEntry: true,
              fileName: 'assets/keys.js',
              facadeModuleId: resolve(repoRoot, 'tests/browser/lane-duplicate-keys.tsx'),
              viteMetadata: { importedCss: new Set(['assets/ignored.css']) },
              imports: [],
              dynamicImports: [],
            },
          ],
        },
      ];
    },
  });
  assert.deepEqual(multiConfigs[0].define, { 'process.env.NODE_ENV': '"development"' });
  assert.deepEqual(Object.keys(multiConfigs[0].build.rolldownOptions.input).sort(), ['extra', 'keys']);
  assert.deepEqual(multi.entries['/keys.html'].css, []);
  assert.doesNotMatch(multi.pages['/keys.html'], /<link rel="stylesheet"/);
  assert.match(multi.pages['/keys.html'], /<html lang="en">/);
  assert.match(multi.pages['/keys.html'], /src="\/assets\/keys\.js"/);

  await assert.rejects(
    buildBrowserFixture(out, {
      entry: 'a.tsx',
      entries: { '/b.html': 'b.tsx' },
      build: stubBuild,
    }),
    /Pass exactly one/,
  );
  await assert.rejects(
    buildBrowserFixture(out, {
      entry: 'tests/browser/missing.tsx',
      build: async () => ({ output: [] }),
    }),
    /produced no entry chunk/,
  );
});

test('09961b44: serveBrowserFixture serves dynamic HTML and static assets over loopback HTTP and blocks traversal', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-browser-serve-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(join(out, 'app.js'), 'export const ok = true;');
  writeFileSync(join(out, 'app.css'), 'body{margin:0}');

  const server = await serveBrowserFixture(out, url =>
    url.pathname === '/'
      ? fixturePageHtml({
          entry: 'app.js',
          css: ['app.css'],
          title: 'Static fixture',
          htmlAttrs: url.searchParams.has('ds')
            ? 'lang="en" data-ds data-theme="dark"'
            : 'lang="en" data-theme="dark"',
        })
      : null,
  );
  t.after(() => server.close());

  const home = await fetch(`${server.url}/?ds`);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html');
  assert.match(await home.text(), /\bdata-ds\b/);

  const plain = await fetch(`${server.url}/`);
  assert.equal(plain.status, 200);
  assert.doesNotMatch(await plain.text(), /\bdata-ds\b/);

  const script = await fetch(`${server.url}/app.js`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');
  assert.equal(await script.text(), 'export const ok = true;');

  const style = await fetch(`${server.url}/app.css`);
  assert.equal(style.status, 200);
  assert.equal(style.headers.get('content-type'), 'text/css');

  const missing = await fetch(`${server.url}/missing.js`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${server.url}/..%2Fpackage.json`);
  assert.equal(traversal.status, 404);
});

test('09961b44: routeBrowserFixture serves mapped HTML and static assets, blocks outside hosts and rejects traversal', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-browser-route-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(join(out, 'app.js'), 'console.log(1);');
  writeFileSync(join(out, 'app.css'), 'body{}');
  writeFileSync(join(out, 'font.woff2'), Buffer.from([1, 2, 3]));

  let handler;
  const page = {
    async route(pattern, fn) {
      assert.equal(pattern, '**/*');
      handler = fn;
    },
  };
  const external = [];
  await routeBrowserFixture(
    page,
    out,
    { '/needs.html': '<!doctype html><title>Needs</title>' },
    { onExternal: url => external.push(url.href) },
  );

  const invoke = async href => {
    const calls = [];
    await handler({
      request: () => ({ url: () => href }),
      continue: () => calls.push({ kind: 'continue' }),
      abort: () => calls.push({ kind: 'abort' }),
      fulfill: response => calls.push({ kind: 'fulfill', response }),
    });
    assert.equal(calls.length, 1);
    return calls[0];
  };

  assert.equal((await invoke('data:text/plain,ok')).kind, 'continue');
  assert.equal((await invoke('https://outside.invalid/x.js')).kind, 'abort');
  assert.deepEqual(external, ['https://outside.invalid/x.js']);

  const html = await invoke('https://forge.test/needs.html?data=busy');
  assert.equal(html.kind, 'fulfill');
  assert.equal(html.response.contentType, 'text/html');
  assert.match(html.response.body, /<title>Needs<\/title>/);

  const js = await invoke('https://forge.test/app.js');
  assert.equal(js.response.contentType, 'text/javascript');
  assert.equal(js.response.body.toString(), 'console.log(1);');

  const font = await invoke('https://forge.test/font.woff2');
  assert.equal(font.response.contentType, 'font/woff2');

  const missing = await invoke('https://forge.test/absent.js');
  assert.equal(missing.response.status, 404);

  const traversal = await invoke('https://forge.test/../../package.json');
  assert.equal(traversal.response.status, 404);

  assert.equal(readFixtureAsset(out, '/../../package.json'), null);
  assert.equal(fixtureContentType('a.css'), 'text/css');
  assert.equal(fixtureContentType('a.wasm'), 'application/wasm');
});
