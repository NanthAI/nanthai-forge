// SPDX-License-Identifier: Apache-2.0
// The site's cached public read (netlify/functions/public-read.mts, Items 6a60e89a and 875a4b60): it forwards no
// cookie or credential, keeps only public cache headers, briefly caches failure envelopes, adds share tags only from the
// public read, and gives a private or missing project the same plain app page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { moduleUrl, moduleSource } from './convex-module.mjs';

const functionSource = moduleSource('../netlify/functions/public-read.mts').replace(
  new URL('../netlify/lib/public-meta.js', import.meta.url).href,
  moduleUrl('../netlify/lib/public-meta.ts'),
);
const {
  default: serve,
  readFor,
  config,
} = await import(`data:text/javascript;base64,${Buffer.from(functionSource).toString('base64')}`);
const SITE = 'https://backend.example';
const APP = '<html><head><title>Forge</title><script>theme()</script></head><body></body></html>';
const PAGE = {
  project: { handle: 'ada', slug: 'atlas', name: 'atlas' },
  stars: 2,
  activity: { landings: 5, main: 'passing' },
  plan: { shown: true, left: 4 },
  lanes: { open: 1 },
};

function backend(t, answers) {
  const asked = [];
  t.mock.method(fs, 'readFile', async () => APP);
  const names = ['FORGE_CONVEX_SITE_URL', 'FORGE_WEB_URL', 'FORGE_PUBLIC_READ_SECRET'];
  const previous = names.map(name => process.env[name]);
  process.env.FORGE_WEB_URL = 'https://site.example';
  process.env.FORGE_PUBLIC_READ_SECRET = 'synthetic-site-key';
  process.env.FORGE_CONVEX_SITE_URL = SITE;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, headers: new Headers(init.headers) });
    const answer = answers(url);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  });
  return asked;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'netlify-cdn-cache-control': 'public, durable, s-maxage=30, must-revalidate',
      'set-cookie': 'x=1',
    },
  });

test('a cached read is proxied without credentials and keeps only the cache headers', async t => {
  const asked = backend(t, () => json({ found: true }));
  const response = await serve(
    new Request('https://site.example/-/public/v1/explore/active.json', {
      headers: { cookie: 'session=secret', authorization: 'Bearer secret' },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(asked[0].url, `${SITE}/public/v1/explore/active.json`);
  assert.equal(asked[0].headers.get('cookie'), null);
  assert.equal(asked[0].headers.get('authorization'), null);
  assert.equal(asked[0].headers.get('x-forge-public-key'), 'synthetic-site-key');
  assert.equal(asked[0].headers.get('x-forge-public-origin'), null);
  assert.match(response.headers.get('netlify-cdn-cache-control'), /durable, s-maxage=30/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a failed backend is cached for 30 seconds without stale serving', async t => {
  backend(t, () => new Response('down', { status: 503 }));
  const down = await serve(new Request('https://site.example/sitemap.xml'));
  assert.equal(down.status, 502);
  assert.equal(down.headers.get('cache-control'), 'no-store');
  assert.equal(
    down.headers.get('netlify-cdn-cache-control'),
    'public, durable, s-maxage=30, must-revalidate',
  );
});

test('a public page gets share tags from the public read; private and missing get the same plain page', async t => {
  backend(t, url =>
    url.endsWith('/app.html')
      ? new Response(APP, { headers: { 'content-security-policy': "default-src 'self'" } })
      : url.endsWith('/ada/atlas.json')
        ? json(PAGE)
        : json({ found: false }, 404),
  );
  const shown = await serve(new Request('https://site.example/-/ada/atlas'));
  const html = await shown.text();
  assert.match(html, /<title>ada\/atlas · Forge<\/title>/);
  assert.match(html, /Main is passing\. 5 changes landed this week\. 1 Lane open\. 4 Items left\. 2 stars\./);
  assert.equal(html.match(/<script/g).length, 1, 'no script added');
  assert.match(shown.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const hidden = await (await serve(new Request('https://site.example/-/ada/private-one'))).text();
  const missing = await (await serve(new Request('https://site.example/-/ada/no-such'))).text();
  assert.equal(hidden, APP);
  assert.equal(missing, APP);
});

test('only explore, profiles and project front pages map to a public read', () => {
  assert.equal(readFor('/-/explore').json, '/-/public/v1/explore/active.json');
  assert.equal(readFor('/-/ada').json, '/-/public/v1/profile/ada.json');
  assert.equal(readFor('/-/ada/atlas').json, '/-/public/v1/project/ada/atlas.json');
  for (const path of [
    '/-/account',
    '/-/signin',
    '/-/new',
    '/-/device',
    '/-/terms',
    '/-/privacy',
    '/-/public',
    '/-/explore/x',
    '/-/%E0%A4%A',
  ])
    assert.equal(readFor(path), null, path);
});

test('query strings redirect to the configured bare identity with zero reads, including arbitrary vary names', async t => {
  const asked = backend(t, () => {
    throw new Error('must not fetch');
  });
  for (const path of ['/sitemap.xml', '/-/public/v1/project/ada/atlas.json']) {
    for (const query of ['?utm_source=x', '?cache=1', '?cache=2&x=3']) {
      const response = await serve(new Request(`https://untrusted.example${path}${query}`));
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), `https://site.example${path}`);
    }
  }
  assert.equal(asked.length, 0);
  assert.deepEqual(config.rateLimit, { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] });
});

test('self fetches and share URLs use configuration even on another request host', async t => {
  const asked = backend(t, url => (url.endsWith('/app.html') ? new Response(APP) : json(PAGE)));
  const response = await serve(new Request('https://untrusted.example/-/ada/atlas'));
  const html = await response.text();
  assert.match(html, /https:\/\/site.example\/-\/ada\/atlas/);
  assert.doesNotMatch(html, /untrusted/);
  assert.deepEqual(
    asked.map(call => call.url),
    [`${SITE}/public/v1/project/ada/atlas.json`],
  );
});

test('missing configured site address serves the bundled shell without a request-controlled fetch', async t => {
  const asked = backend(t, () => {
    throw new Error('must not fetch');
  });
  const saved = process.env.URL;
  delete process.env.URL;
  delete process.env.FORGE_WEB_URL;
  t.after(() => {
    if (saved !== undefined) process.env.URL = saved;
  });
  const response = await serve(new Request('https://untrusted.example/-/ada/atlas'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), APP);
  assert.equal(asked.length, 0);
});

test('failure cache envelopes absorb repeated misses while retaining the error status', async t => {
  const asked = backend(t, () => new Response('down', { status: 503 }));
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async () => ({
        match: async key => values.get(key)?.clone(),
        put: async (key, response) => {
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
          values.set(key, response.clone());
        },
      }),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  });
  for (let n = 0; n < 4; n++)
    assert.equal(
      (await serve(new Request('https://site.example/-/public/v1/project/ada/atlas.json'))).status,
      502,
    );
  assert.equal(asked.length, 1);
  values.clear(); // Model platform TTL expiry, without sleeping.
  await serve(new Request('https://site.example/-/public/v1/project/ada/atlas.json'));
  assert.equal(asked.length, 2);
});

test('HTML query state stays in the browser while durable caching uses only page identity', async t => {
  const asked = backend(t, url => (url.endsWith('/app.html') ? new Response(APP) : json(PAGE)));
  const stored = new Map();
  for (const query of ['?q=one', '?q=two&utm_source=test', '?cache=unbounded']) {
    const request = new Request(`https://site.example/-/ada/atlas${query}`);
    // Model the declared Netlify-Vary rule. Its sole query parameter is guaranteed absent before reads.
    const url = new URL(request.url);
    const identity = `${url.pathname}:${url.searchParams.get('__forge_page') ?? ''}`;
    if (!stored.has(identity)) {
      const response = await serve(request);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('netlify-vary'), 'query=__forge_page');
      stored.set(identity, response);
    }
    assert.equal(request.url, `https://site.example/-/ada/atlas${query}`);
  }
  assert.equal(asked.length, 1, 'one backend fetch across all query variants; shell is bundled');
  const redirected = await serve(new Request('https://site.example/-/ada/atlas?__forge_page=vary-me&q=kept'));
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get('location'), 'https://site.example/-/ada/atlas?q=kept');
  assert.equal(asked.length, 1);
});

for (const failure of [401, 500, 503, 'network', 'invalid-json'])
  test(`public-read ${failure} keeps every HTML front page as the plain app`, async t => {
    backend(t, () =>
      failure === 'network'
        ? new Error('network unavailable')
        : failure === 'invalid-json'
          ? new Response('invalid json')
          : json({ found: false }, failure),
    );
    for (const path of ['/-/explore', '/-/ada', '/-/ada/atlas']) {
      const response = await serve(new Request(`https://site.example${path}`));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), APP);
      assert.match(response.headers.get('content-type'), /text\/html/);
    }
  });

for (const missing of ['FORGE_PUBLIC_READ_SECRET', 'FORGE_CONVEX_SITE_URL'])
  test(`missing ${missing} keeps members on the plain app without a backend call`, async t => {
    const asked = backend(t, () => {
      throw new Error('must not fetch');
    });
    delete process.env[missing];
    for (const path of ['/-/explore', '/-/ada', '/-/ada/atlas']) {
      const response = await serve(new Request(`https://site.example${path}`));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), APP);
    }
    assert.equal(asked.length, 0);
  });

test('case, encoding and slash variants redirect before any public backend call', async t => {
  const asked = backend(t, () => {
    throw new Error('must not fetch');
  });
  for (const [variant, canonical] of [
    ['/-/ADA/ATLAS', '/-/ada/atlas'],
    ['/-/EXPLORE', '/-/explore'],
    ['/-/%61da/%61tlas', '/-/ada/atlas'],
    ['/-//ada///atlas/', '/-/ada/atlas'],
    ['//-/ada/', '/-/ada'],
    ['/-/ada/atlas/', '/-/ada/atlas'],
    ['/SITEMAP.XML/', '/sitemap.xml'],
    ['/-/public/v1/project/ADA/%61tlas.json', '/-/public/v1/project/ada/atlas.json'],
  ]) {
    assert(
      config.path.some(path => new URLPattern({ pathname: path }).test(`https://site.example${variant}`)),
      variant,
    );
    const response = await serve(new Request(`https://site.example${variant}`));
    assert.equal(response.status, 308, variant);
    assert.equal(response.headers.get('location'), `https://site.example${canonical}`, variant);
  }
  assert.equal(asked.length, 0);
  for (const path of ['/-/ada/atlas/private', '/-/account/devices/edit'])
    assert.equal(
      config.path.some(pattern => new URLPattern({ pathname: pattern }).test(`https://site.example${path}`)),
      false,
      path,
    );
});

test('missing public records are cached briefly and retain a 404 status', async t => {
  const asked = backend(t, () => json({ found: false }, 404));
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async () => ({
        match: async key => values.get(key)?.clone(),
        put: async (key, response) => {
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
          values.set(key, response.clone());
        },
      }),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  });
  for (let n = 0; n < 3; n++) {
    const response = await serve(new Request('https://site.example/-/public/v1/project/ada/missing.json'));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { found: false });
    assert.match(response.headers.get('netlify-cdn-cache-control'), /s-maxage=30/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  }
  assert.equal(asked.length, 1);
  values.clear();
  await serve(new Request('https://site.example/-/public/v1/project/ada/missing.json'));
  assert.equal(asked.length, 2);
});

test('function responses enforce the site security policy without upstream headers', async t => {
  backend(t, () => json(PAGE));
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const block = toml.split('[[headers]]')[1].split('[[redirects]]')[0];
  const security = [...block.matchAll(/^([A-Za-z-]+) = "([^"\n]*)"$/gm)]
    .filter(([_, name]) => name !== 'for')
    .map(([_, name, value]) => [name, value]);
  for (const path of ['/-/ada/atlas', '/-/public/v1/explore/active.json', '/-/ADA']) {
    const response = await serve(new Request(`https://site.example${path}`));
    for (const [name, value] of security) assert.equal(response.headers.get(name), value, `${path}: ${name}`);
  }
  const denied = await serve(new Request('https://site.example/-/ada', { method: 'POST' }));
  for (const [name, value] of security) assert.equal(denied.headers.get(name), value);
  assert.match(toml, /\[functions\."public-read"\]\s+included_files = \["hosted-web-dist\/app\.html"\]/);
});
