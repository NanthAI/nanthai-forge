// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 702af738: the dev site moved to its own address, and passkeys belong to one address, so the Worker's
// workers.dev address sends every app page, sign-in call and front-door visit to the canonical origin (FORGE_WEB_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { serve } = await import(moduleUrl('../site/worker.ts'));
const PAGE = '<html><body>front door</body></html>';
const env = {
  ASSETS: { fetch: async request => new Response(new URL(request.url).pathname === '/' ? PAGE : 'app') },
  FORGE_WEB_URL: 'https://dev.forge.example',
};

test('Item 702af738: the workers.dev address redirects app pages, CLI sign-in posts and the front door to the canonical origin', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('a redirect makes no backend call');
  });
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/account/devices?tab=keys'],
    ['GET', '/projects?project=synthetic&planningItem=one'],
    ['POST', '/auth/device/start-v2'],
    ['POST', '/auth/device/renew'],
  ]) {
    const response = await serve(
      new Request(`https://forge-dev.synthetic.workers.dev${path}`, {
        method,
        body: method === 'POST' ? '{}' : null,
      }),
      env,
    );
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get('location'), `https://dev.forge.example${path}`);
    assert.ok(response.headers.get('content-security-policy'), 'the redirect carries the security headers');
  }
});

test('Item 702af738: the canonical address serves the front door from the static files; other hosts are untouched', async () => {
  const home = await serve(new Request('https://dev.forge.example/'), env);
  assert.equal(home.status, 200);
  assert.equal(await home.text(), PAGE);
  assert.ok(home.headers.get('content-security-policy'));
  for (const [url, settings] of [
    ['https://preview.example/', env],
    ['http://127.0.0.1:8787/', env],
    ['https://forge-dev.synthetic.workers.dev/', { ...env, FORGE_WEB_URL: undefined }],
    [
      'https://forge-dev.synthetic.workers.dev/',
      { ...env, FORGE_WEB_URL: 'https://forge-dev.synthetic.workers.dev' },
    ],
    ['https://forge-dev.synthetic.workers.dev/', { ...env, FORGE_WEB_URL: 'http://dev.forge.example' }],
  ]) {
    const response = await serve(new Request(url), settings);
    assert.equal(response.status, 200, `${url} with ${settings.FORGE_WEB_URL}`);
  }
});
