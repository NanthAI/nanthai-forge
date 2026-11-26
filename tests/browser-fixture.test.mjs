// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Contract tests for the shared Vite fixture build and static server/router helper (Item 09961b44, friction 87e5d6c7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBrowserFixture,
  fixtureContentType,
  routeBrowserFixture,
  serveBrowserFixture,
} from './browser-fixture.mjs';

test('09961b44: buildBrowserFixture emits entry JS, walks only entry CSS and serves assets over loopback HTTP', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-browser-fixture-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const built = await buildBrowserFixture(out, {
    entry: 'tests/browser/setting-change.tsx',
    title: 'Settings change fixture',
    bodyStyle: 'margin:0',
  });
  assert.match(built.entry, /\.js$/);
  assert.ok(existsSync(join(out, built.entry)), 'entry script exists in outDir');
  assert.ok(built.css.length >= 1, 'entry CSS chunks are collected');
  for (const file of built.css) {
    assert.ok(existsSync(join(out, file)), `linked CSS ${file} exists in outDir`);
    assert.match(built.html, new RegExp(`href="/${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.match(built.html, /<title>Settings change fixture<\/title>/);
  assert.match(built.html, /<body style="margin:0">/);
  const noDs = built.page({ htmlAttrs: 'lang="en" data-theme="dark"' });
  assert.doesNotMatch(noDs, /\bdata-ds\b/);
  assert.match(built.html, /\bdata-ds\b/);

  const server = await serveBrowserFixture(out, url =>
    url.pathname === '/'
      ? built.page({
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

  const script = await fetch(`${server.url}/${built.entry}`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');
  assert.ok((await script.text()).length > 0);

  const style = await fetch(`${server.url}/${built.css[0]}`);
  assert.equal(style.status, 200);
  assert.equal(style.headers.get('content-type'), 'text/css');

  const missing = await fetch(`${server.url}/missing.js`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${server.url}/..%2Fpackage.json`);
  assert.equal(traversal.status, 404);

  // Multi-entry map with css disabled (as used by multi-page and development-React browser tests).
  const multiOut = mkdtempSync(join(tmpdir(), 'forge-browser-multi-'));
  t.after(() => rmSync(multiOut, { recursive: true, force: true }));
  const multi = await buildBrowserFixture(multiOut, {
    entries: { '/keys.html': 'tests/browser/lane-duplicate-keys.tsx' },
    title: 'Duplicate keys',
    htmlAttrs: 'lang="en"',
    css: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  assert.deepEqual(multi.entries['/keys.html'].css, []);
  assert.doesNotMatch(multi.pages['/keys.html'], /<link rel="stylesheet"/);
  assert.match(multi.pages['/keys.html'], /<html lang="en">/);
  assert.ok(existsSync(join(multiOut, multi.entries['/keys.html'].entry)));
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

  assert.equal(fixtureContentType('a.css'), 'text/css');
  assert.equal(fixtureContentType('a.wasm'), 'application/wasm');
});
