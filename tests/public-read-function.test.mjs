// SPDX-License-Identifier: Apache-2.0
// The site's cached public read (netlify/functions/public-read.mts, Items 6a60e89a and 875a4b60): it forwards no
// cookie or credential, keeps only public cache headers, briefly caches failure envelopes, adds share tags only from the
// public read, and gives a private or missing project the same plain app page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleUrl, moduleSource } from './convex-module.mjs';
import {
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  publicCodeIngressKey,
} from '../dist/public-code-cache.js';

const functionSource = moduleSource('../netlify/functions/public-read.mts')
  .replace(
    new URL('../netlify/lib/public-meta.js', import.meta.url).href,
    moduleUrl('../netlify/lib/public-meta.ts'),
  )
  .replace(new URL('../web/src/app/paths.js', import.meta.url).href, moduleUrl('../web/src/app/paths.ts'));
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
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (path, ...args) =>
    String(path).replaceAll('\\', '/').endsWith('/hosted-web-dist/app.html') ? APP : readFile(path, ...args),
  );
  const names = [
    'FORGE_CONVEX_SITE_URL',
    'FORGE_WEB_URL',
    'FORGE_PUBLIC_READ_SECRET',
    'FORGE_PUBLIC_CODE_WORKER_URL',
  ];
  const previous = names.map(name => process.env[name]);
  process.env.FORGE_WEB_URL = 'https://site.example';
  process.env.FORGE_PUBLIC_READ_SECRET = 'synthetic-site-key';
  process.env.FORGE_CONVEX_SITE_URL = SITE;
  delete process.env.FORGE_PUBLIC_CODE_WORKER_URL;
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

const CODE_PATH = `/public/v1/code/ada/atlas/${'1'.repeat(64)}/page/612e7473/0.json`;
const WORKER_URL = 'https://worker.example';

test('a public file uses scoped Worker ingress and the site keeps only its remaining lifetime', async t => {
  t.mock.method(Date, 'now', () => 15_250);
  const asked = backend(
    t,
    () =>
      new Response('{"file":{"available":true}}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          [PUBLIC_CODE_EXPIRY]: '30000',
          [PUBLIC_CODE_DELIVERY]: 'r2',
        },
      }),
  );
  process.env.FORGE_PUBLIC_CODE_WORKER_URL = WORKER_URL;
  const response = await serve(
    new Request('https://site.example/-' + CODE_PATH, { headers: { cookie: 'session=secret' } }),
  );
  assert.equal(await response.text(), '{"file":{"available":true}}');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, WORKER_URL + CODE_PATH);
  assert.equal(asked[0].headers.get(PUBLIC_CODE_INGRESS), await publicCodeIngressKey('synthetic-site-key'));
  assert.equal(asked[0].headers.get('x-forge-public-key'), null);
  assert.equal(asked[0].headers.get('cookie'), null);
  assert.equal(response.headers.get(PUBLIC_CODE_EXPIRY), null);
  assert.equal(response.headers.get(PUBLIC_CODE_DELIVERY), 'r2');
  assert.equal(
    response.headers.get('netlify-cdn-cache-control'),
    'public, durable, s-maxage=14, must-revalidate',
  );
});

test('past or out-of-window Worker expiries cannot populate the site cache', async t => {
  t.mock.method(Date, 'now', () => 30_000);
  let expiry = '30000';
  backend(
    t,
    () => new Response('{"file":{"available":true}}', { headers: { [PUBLIC_CODE_EXPIRY]: expiry } }),
  );
  process.env.FORGE_PUBLIC_CODE_WORKER_URL = WORKER_URL;
  for (const value of ['30000', '60001', 'Infinity']) {
    expiry = value;
    const response = await serve(new Request('https://site.example/-' + CODE_PATH));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store', value);
  }
});

test('an ambiguous Worker failure gets one upstream attempt while history uses the existing reader', async t => {
  const asked = backend(t, url =>
    url.startsWith(WORKER_URL) ? new Error('worker timed out') : json({ landings: [] }),
  );
  process.env.FORGE_PUBLIC_CODE_WORKER_URL = WORKER_URL;
  assert.equal((await serve(new Request('https://site.example/-' + CODE_PATH))).status, 502);
  assert.deepEqual(
    asked.map(({ url }) => url),
    [WORKER_URL + CODE_PATH],
  );
  const history = '/public/v1/code/ada/atlas/history.json';
  assert.deepEqual(await (await serve(new Request('https://site.example/-' + history))).json(), {
    landings: [],
  });
  assert.equal(asked[1].url, SITE + history);
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

test('reserved data cache selectors redirect without a backend read', async t => {
  const asked = backend(t, () => {
    throw new Error('must not fetch');
  });
  for (const path of ['/sitemap.xml', '/-/public/v1/project/ada/atlas.json']) {
    for (const [query, target] of [
      ['?__forge_page=unbounded', '?='],
      ['?%5f%5fforge_page=unbounded&x=3', '?x=3'],
    ]) {
      const response = await serve(new Request(`https://untrusted.example${path}${query}`));
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), `https://site.example${path}${target}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(asked.length, 0);
  assert.deepEqual(config.rateLimit, { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] });
});

test('reserved HTML selectors cannot self-redirect after Netlify query pass-through', async t => {
  const require = createRequire(import.meta.resolve('netlify-cli/package.json'));
  const { RedirectsHandler } = await import(pathToFileURL(require.resolve('@netlify/redirects')).href);
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-public-redirect-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/public-read-netlify.json', import.meta.url)),
  ).queryRedirects;
  const asked = backend(t, () => json(PAGE));
  for (const fixture of fixtures) {
    const request = new Request(`https://site.example${fixture.path}`);
    const response = await serve(request);
    assert.equal(response.status, 308);
    const matcher = new RedirectsHandler({
      projectDir: directory,
      configRedirects: [{ from: '/*', to: response.headers.get('location'), status: 308, force: true }],
    });
    const onNetlify = await matcher.match(request);
    assert.notEqual(onNetlify.target.href, request.url, 'the platform must not restore a self-redirect');
    assert.equal(onNetlify.target.href, `https://site.example${fixture.location}`);
    const followed = await serve(new Request(onNetlify.target));
    assert.equal(followed.status, 200, 'the redirect reaches a fixed point in one hop');
    assert.equal(followed.headers.get('location'), null);
  }
  assert(asked.every(({ url }) => url.startsWith(`${SITE}/public/v1/`)));
});

for (const [path, upstream, mime, body] of [
  ['/sitemap.xml', '/public/v1/sitemap.xml', 'application/xml', '<urlset/>'],
  [
    '/-/public/v1/explore/active.json',
    '/public/v1/explore/active.json',
    'application/json',
    '{"found":true}',
  ],
])
  test(`${path} ignores ordinary queries on misses and declares a shared cache identity`, async t => {
    const asked = backend(
      t,
      () =>
        new Response(body, {
          headers: {
            'content-type': mime,
            'netlify-cdn-cache-control': 'public, durable, s-maxage=30, must-revalidate',
          },
        }),
    );
    const queries = ['?forge_probe=61', '', '?=', '?cache=2&x=3'];
    const url = query => new URL(`https://site.example${path}${query}`);
    const cold = await serve(new Request(url(queries[0])));
    const vary = cold.headers.get('netlify-vary');
    assert.equal(vary, 'query=__forge_page');
    const identity = address => [address.pathname, address.searchParams.get(vary.slice('query='.length))];
    for (const query of queries) assert.deepEqual(identity(url(query)), identity(url(queries[0])));
    assert.equal(cold.status, 200);
    assert.equal(cold.headers.get('location'), null);
    assert.equal(cold.headers.get('content-type'), mime);
    assert.equal(await cold.text(), body);
    assert.deepEqual(
      asked.map(call => call.url),
      [`${SITE}${upstream}`],
      'one backend read for the shared entry',
    );
    for (const query of queries.slice(1)) {
      const uncached = await serve(new Request(url(query)));
      assert.equal(uncached.status, cold.status);
      assert.deepEqual([...uncached.headers], [...cold.headers]);
      assert.equal(await uncached.text(), body);
    }
    assert.deepEqual(
      asked.map(call => call.url),
      queries.map(() => `${SITE}${upstream}`),
    );
  });

test('paths outside the public root have a nonempty HTML 404 and cannot reach a backend', async t => {
  const asked = backend(t, () => {
    throw Error('must not fetch');
  });
  for (const path of ['/outside/explore', '/-/../../outside', '/-/public/v1/../../../../outside']) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Page not found/);
    assert.equal(readFor(new URL(`https://site.example${path}`).pathname), null);
  }
  assert.equal(asked.length, 0);
});

test('private app places retain the SPA shell without a public backend read', async t => {
  const asked = backend(t, () => {
    throw Error('must not fetch');
  });
  for (const path of ['/-/account', '/-/signin', '/-/device', '/-/ada/atlas/private']) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), APP);
  }
  assert.equal(asked.length, 0);
});

test('doubled-leading-slash account addresses reach the ordinary SPA without public reads', async t => {
  const asked = backend(t, () => {
    throw Error('must not fetch');
  });
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/public-read-netlify.json', import.meta.url)),
  ).accountRedirects;
  const origin = 'https://site.example';
  for (const { path, location } of fixtures) {
    const request = new Request(`${origin}${path}`);
    assert(
      config.path.some(pattern => new URLPattern({ pathname: pattern }).test(request.url)),
      path,
    );

    const response = await serve(request);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get('location'), `${origin}${location}`, path);

    const account = await serve(new Request(response.headers.get('location')));
    assert.equal(account.status, 200, location);
    assert.equal(account.headers.get('location'), null, location);
    assert.equal(await account.text(), APP, location);
  }
  const outside = await serve(new Request(`${origin}//outside/account`));
  assert.equal(outside.status, 404);
  assert.equal(outside.headers.get('location'), null);
  assert.equal(asked.length, 0);
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

test('private or missing data stays an identical 404 on a warm cache across queries', async t => {
  const asked = backend(t, () => {
    const response = json({ found: false }, 404);
    response.headers.set('access-control-allow-origin', '*');
    return response;
  });
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
  const path = 'https://site.example/-/public/v1/project/ada/missing.json';
  const cold = await serve(new Request(`${path}?source=cold`));
  assert.equal(cold.headers.get('access-control-allow-origin'), '*');
  assert.equal(cold.headers.get('set-cookie'), null);
  assert.equal(cold.status, 404);
  const body = await cold.text();
  assert.deepEqual(JSON.parse(body), { found: false });
  for (const query of ['', '?source=warm']) {
    const response = await serve(new Request(`${path}${query}`));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), body);
    assert.deepEqual([...response.headers], [...cold.headers]);
    assert.match(response.headers.get('netlify-cdn-cache-control'), /s-maxage=30/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  }
  assert.equal(asked.length, 1);
  values.clear();
  await serve(new Request(path));
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
