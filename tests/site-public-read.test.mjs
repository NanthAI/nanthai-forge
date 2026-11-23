// SPDX-License-Identifier: Apache-2.0
// The site Worker's cached public read (site/public-read.ts, Items 6a60e89a, 875a4b60 and ef6aa22a): it forwards no
// cookie or credential, keeps only public cache headers, keeps 200s in the edge cache by canonical path, briefly caches
// failure envelopes, adds share tags only from the public read, and gives a private or missing project the same plain
// app page. Every case runs the real Worker entry (site/worker.ts) with its bindings faked: the static files (ASSETS),
// the rate limiter and Cloudflare's Cache API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import {
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  publicCodeIngressKey,
} from '../dist/public-code-cache.js';
import { clientHash } from '../dist/client-hash.js';

const { serve } = await import(moduleUrl('../site/worker.ts'));
const { readFor, publicRead, isPublicReadPath } = await import(moduleUrl('../site/public-read.ts'));
const { SECURITY_HEADERS } = await import(moduleUrl('../site/headers.ts'));
const SITE = 'https://backend.example';
const APP = '<html><head><title>Forge</title><script>theme()</script></head><body></body></html>';
const PAGE = {
  project: { handle: 'ada', slug: 'atlas', name: 'atlas' },
  stars: 2,
  activity: { landings: 5, main: 'passing' },
  plan: { shown: true, left: 4 },
  lanes: { open: 1 },
};

/** The Worker's bindings and a scripted backend. Every backend request is kept, with its headers. */
function backend(t, answers, settings = {}) {
  const asked = [];
  const env = {
    ASSETS: {
      fetch: async request => {
        assert.equal(new URL(request.url).pathname, '/app', 'the Worker only reads the app shell');
        return new Response(APP, { headers: { 'content-type': 'text/html' } });
      },
    },
    FORGE_WEB_URL: 'https://site.example',
    FORGE_PUBLIC_READ_SECRET: 'synthetic-site-key',
    FORGE_CONVEX_SITE_URL: SITE,
    ...settings,
  };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
    const answer = answers(url);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { asked, env, serve: (request, ctx) => serve(request, env, ctx) };
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

/** Cloudflare's Cache API: `caches.default` (the edge copy of 200s) and named caches (failure envelopes). Removing an
 * entry models its lifetime ending, without sleeping. */
function edgeCaches(t) {
  const store = () => {
    const values = new Map();
    const puts = [];
    return {
      values,
      puts,
      match: async key => values.get(String(key))?.clone(),
      put: async (key, response) => {
        puts.push({
          key: String(key),
          status: response.status,
          cacheControl: response.headers.get('cache-control'),
        });
        values.set(String(key), new Response(await response.arrayBuffer(), response));
      },
    };
  };
  const edge = store(),
    outcomes = store();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: edge, open: async () => outcomes },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  });
  return { edge, outcomes };
}

test('a cached read is proxied without credentials and keeps only the cache headers', async t => {
  const { asked, serve } = backend(t, () => json({ found: true }));
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
  assert.equal(asked[0].redirect, 'manual', 'the site key never follows a redirect');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(response.headers.get('netlify-cdn-cache-control'), null);
  assert.equal(response.headers.get('x-forge-edge-seconds'), null, 'the edge lifetime stays internal');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('a backend redirect is refused, so the site key reaches only the address it was sent to', async t => {
  const { asked, serve } = backend(
    t,
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
  );
  const response = await serve(new Request('https://site.example/-/public/v1/explore/active.json'));
  assert.equal(response.status, 502);
  assert.deepEqual(
    asked.map(call => call.url),
    [`${SITE}/public/v1/explore/active.json`],
  );
});

test('the edge keeps a 200 for the period the backend allows and serves it again without a backend read', async t => {
  const { edge } = edgeCaches(t);
  const { asked, serve } = backend(t, () => json({ found: true }));
  const waited = [];
  const first = await serve(new Request('https://site.example/-/public/v1/explore/active.json'), {
    waitUntil: promise => waited.push(promise),
  });
  assert.equal(await first.text(), '{"found":true}');
  await Promise.all(waited);
  assert.deepEqual(edge.puts, [
    {
      key: 'https://site.example/-/public/v1/explore/active.json',
      status: 200,
      cacheControl: 'public, max-age=30',
    },
  ]);
  const hit = await serve(new Request('https://site.example/-/public/v1/explore/active.json'));
  assert.equal(await hit.text(), '{"found":true}');
  assert.equal(
    hit.headers.get('cache-control'),
    'public, max-age=60',
    'the visitor keeps the backend browser rule',
  );
  assert.equal(hit.headers.get('x-forge-browser-cache-control'), null);
  assert.equal(hit.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
  assert.equal(asked.length, 1);
  edge.values.clear();
  await serve(new Request('https://site.example/-/public/v1/explore/active.json'));
  assert.equal(asked.length, 2, 'an expired entry reads the backend again');
});

const CODE_PATH = `/public/v1/code/ada/atlas/${'1'.repeat(64)}/page/612e7473/0.json`;
const WORKER_URL = 'https://worker.example';

test('a public file uses scoped Worker ingress and the site keeps only its remaining lifetime', async t => {
  t.mock.method(Date, 'now', () => 15_250);
  const { edge } = edgeCaches(t);
  const { asked, serve } = backend(
    t,
    () =>
      new Response('{"file":{"available":true}}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          [PUBLIC_CODE_EXPIRY]: '30000',
          [PUBLIC_CODE_DELIVERY]: 'r2',
        },
      }),
    { FORGE_PUBLIC_CODE_WORKER_URL: WORKER_URL },
  );
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
  assert.equal(edge.puts[0].cacheControl, 'public, max-age=14');
});

test('b6588425: a miss forwards only the keyed hash of the platform address, never one the visitor sends', async t => {
  const { asked, serve } = backend(t, () => json({ found: true }), {
    FORGE_CLIENT_HASH_KEY: 'synthetic-client-hash-key',
    FORGE_PUBLIC_CODE_WORKER_URL: WORKER_URL,
  });
  const ip = '203.0.113.7';
  const forged = { 'x-forge-client': 'f'.repeat(64), 'x-forwarded-for': '198.51.100.9' };
  const request = (path, platform) =>
    new Request(`https://site.example/-${path}`, {
      headers: platform ? { ...forged, 'cf-connecting-ip': platform } : forged,
    });
  await serve(request(CODE_PATH, ip));
  await serve(request('/public/v1/code/ada/atlas/history.json', ip));
  await serve(request(CODE_PATH));
  const hash = await clientHash('synthetic-client-hash-key', ip);
  assert.deepEqual(
    asked.map(({ url, headers }) => [new URL(url).origin, headers.get('x-forge-client')]),
    [
      [WORKER_URL, hash],
      [SITE, hash],
      [WORKER_URL, null],
    ],
    'the Worker and the backend get the hash; without a platform address nothing is forwarded',
  );
  for (const { url, headers } of asked)
    assert.ok(!`${url} ${JSON.stringify([...headers])}`.match(/203\.0\.113\.7|198\.51\.100\.9/));
});

test('past or out-of-window Worker expiries cannot populate the site cache', async t => {
  t.mock.method(Date, 'now', () => 30_000);
  const { edge } = edgeCaches(t);
  let expiry = '30000';
  const { serve } = backend(
    t,
    () => new Response('{"file":{"available":true}}', { headers: { [PUBLIC_CODE_EXPIRY]: expiry } }),
    { FORGE_PUBLIC_CODE_WORKER_URL: WORKER_URL },
  );
  for (const value of ['30000', '60001', 'Infinity']) {
    expiry = value;
    const response = await serve(new Request('https://site.example/-' + CODE_PATH));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store', value);
  }
  assert.deepEqual(edge.puts, []);
});

test('an ambiguous Worker failure gets one upstream attempt while history uses the existing reader', async t => {
  const { asked, serve } = backend(
    t,
    url => (url.startsWith(WORKER_URL) ? new Error('worker timed out') : json({ landings: [] })),
    { FORGE_PUBLIC_CODE_WORKER_URL: WORKER_URL },
  );
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

test('a failed backend is never kept in the edge copy and its envelope lasts 30 seconds', async t => {
  const { edge, outcomes } = edgeCaches(t);
  const { asked, serve } = backend(t, () => new Response('down', { status: 503 }));
  const down = await serve(new Request('https://site.example/sitemap.xml'));
  assert.equal(down.status, 502);
  assert.equal(down.headers.get('cache-control'), 'no-store');
  assert.equal(down.headers.get('x-forge-edge-seconds'), null);
  assert.deepEqual(edge.puts, []);
  assert.deepEqual(
    outcomes.puts.map(put => put.cacheControl),
    ['public, max-age=30'],
  );
  for (let n = 0; n < 3; n++)
    assert.equal((await serve(new Request('https://site.example/sitemap.xml'))).status, 502);
  assert.equal(asked.length, 1, 'the envelope absorbs repeated misses');
  outcomes.values.clear();
  await serve(new Request('https://site.example/sitemap.xml'));
  assert.equal(asked.length, 2);
});

test('a public page gets share tags from the public read; private and missing get the same plain page', async t => {
  const { serve } = backend(t, url =>
    url.endsWith('/ada/atlas.json') ? json(PAGE) : json({ found: false }, 404),
  );
  const shown = await serve(new Request('https://site.example/ada/atlas'));
  const html = await shown.text();
  assert.match(html, /<title>ada\/atlas · Forge<\/title>/);
  assert.match(html, /Main is passing\. 5 changes landed this week\. 1 Lane open\. 4 Items left\. 2 stars\./);
  assert.equal(html.match(/<script/g).length, 1, 'no script added');
  assert.match(shown.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const hidden = await (await serve(new Request('https://site.example/ada/private-one'))).text();
  const missing = await (await serve(new Request('https://site.example/ada/no-such'))).text();
  assert.equal(hidden, APP);
  assert.equal(missing, APP);
});

test('only explore, profiles and project front pages map to a public read', () => {
  assert.equal(readFor('/explore').json, '/-/public/v1/explore/active.json');
  assert.equal(readFor('/ada').json, '/-/public/v1/profile/ada.json');
  assert.equal(readFor('/ada/atlas').json, '/-/public/v1/project/ada/atlas.json');
  for (const path of [
    '/account',
    '/signin',
    '/new',
    '/device',
    '/terms',
    '/privacy',
    '/public',
    '/explore/x',
    '/%E0%A4%A',
    // b0704959: the earlier /- form is a redirect, files and the docs are static, and a probe never names a handle.
    '/-/ada',
    '/-/ada/atlas',
    '/docs',
    '/projects',
    '/wp-login.php',
    '/.env',
    '/ada/at.las',
    '/-ada',
  ])
    assert.equal(readFor(path), null, path);
});

test('the per-address limit answers 429 before a backend read, and an edge copy is served without it', async t => {
  const { edge } = edgeCaches(t);
  const keys = [];
  let allowed = true;
  const { asked, serve } = backend(t, () => json({ found: true }), {
    PUBLIC_LIMIT: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: allowed };
      },
    },
  });
  const request = () =>
    new Request('https://site.example/-/public/v1/explore/active.json', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
  assert.equal((await serve(request())).status, 200);
  allowed = false;
  assert.equal(
    (await serve(request())).status,
    200,
    'the edge copy costs no backend call, so it is not limited',
  );
  edge.values.clear();
  const limited = await serve(request());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(asked.length, 1);
  assert.deepEqual(keys, ['203.0.113.7', '203.0.113.7']);
});

test('a limiter error never blocks a visitor', async t => {
  const { serve } = backend(t, () => json({ found: true }), {
    PUBLIC_LIMIT: { limit: async () => Promise.reject(new Error('limiter down')) },
  });
  assert.equal(
    (await serve(new Request('https://site.example/-/public/v1/explore/active.json'))).status,
    200,
  );
});

test('the limit counts only backend reads: app places and redirects stay open, a limited page keeps its plain shell', async t => {
  edgeCaches(t);
  const { asked, serve } = backend(t, () => json(PAGE), {
    PUBLIC_LIMIT: { limit: async () => ({ success: false }) },
  });
  for (const path of ['/signin', '/account', '/projects', '/ada/atlas/private']) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), APP, path);
  }
  for (const [path, status] of [
    ['/-/projects', 301],
    ['/EXPLORE', 308],
  ])
    assert.equal((await serve(new Request(`https://site.example${path}`))).status, status, path);
  // A public front page over the limit is the app without share tags, never a 429.
  const front = await serve(new Request('https://site.example/ada/atlas'));
  assert.equal(front.status, 200);
  assert.equal(await front.text(), APP);
  assert.equal(
    (await serve(new Request('https://site.example/-/public/v1/explore/active.json'))).status,
    429,
  );
  assert.equal(asked.length, 0);
});

test('a failing cache is a miss and a copy that cannot be stored is dropped, never a 502', async t => {
  const reject = async () => {
    throw new Error('cache unavailable');
  };
  const failing = { match: reject, put: reject };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  });
  const { serve } = backend(t, url =>
    url.includes('/project/') ? json({ error: 'not found' }, 404) : json({ found: true }),
  );
  for (const open of [async () => failing, reject]) {
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: failing, open } });
    const app = await serve(new Request('https://site.example/projects'));
    assert.equal(app.status, 200);
    assert.equal(await app.text(), APP);
    assert.equal(
      (await serve(new Request('https://site.example/-/public/v1/explore/active.json'))).status,
      200,
    );
    assert.equal(
      (await serve(new Request('https://site.example/-/public/v1/project/ada/missing.json'))).status,
      404,
    );
  }
});

test('the earlier reserved page selector is an ordinary query: no redirect, one shared entry', async t => {
  edgeCaches(t);
  const { asked, serve } = backend(t, url =>
    url.endsWith('/explore/active.json') ? json({ projects: [] }) : json({}),
  );
  for (const path of ['/explore?__forge_page=x', '/explore?=', '/sitemap.xml?__forge_page=x']) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('location'), null, path);
  }
  assert.equal(asked.length, 2, 'one read for the explore page, one for the sitemap');
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
  test(`${path} shares one edge entry across ordinary queries`, async t => {
    edgeCaches(t);
    const { asked, serve } = backend(
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
    const cold = await serve(new Request(`https://site.example${path}${queries[0]}`));
    assert.equal(cold.status, 200);
    assert.equal(cold.headers.get('location'), null);
    assert.equal(cold.headers.get('content-type'), mime);
    assert.equal(await cold.text(), body);
    for (const query of queries.slice(1)) {
      const hit = await serve(new Request(`https://site.example${path}${query}`));
      assert.equal(hit.status, cold.status);
      assert.deepEqual([...hit.headers], [...cold.headers]);
      assert.equal(await hit.text(), body);
    }
    assert.deepEqual(
      asked.map(call => call.url),
      [`${SITE}${upstream}`],
      'one backend read for the shared entry',
    );
  });

test('addresses that are not app pages have a nonempty HTML 404 and cannot reach a backend', async t => {
  const { asked, env } = backend(t, () => {
    throw Error('must not fetch');
  });
  // The Worker routes these to the app or to static files (isPublicReadPath below); the read itself still refuses them.
  for (const path of ['/docs', '/assets/x', '/a.b/c', '/llms.txt']) {
    const response = await publicRead(new Request(`https://site.example${path}`), env, null);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Page not found/);
    assert.equal(readFor(new URL(`https://site.example${path}`).pathname), null);
    assert.equal(isPublicReadPath(`https://site.example${path}`), false, path);
  }
  assert.equal(asked.length, 0);
});

test('b0704959: an earlier /- page address moves for good to the root with its query, without a backend read', async t => {
  const { asked, serve } = backend(t, () => {
    throw Error('must not fetch');
  });
  for (const [path, location] of [
    ['/-/ada/atlas?view=public', '/ada/atlas?view=public'],
    ['/-/explore', '/explore'],
    ['/-/ADA', '/ADA'],
    ['//-/account', '/account'],
    ['/-/account?request=r1', '/account?request=r1'],
    ['/-/', '/account'],
    ['/-//evil.example', '/evil.example'],
  ]) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get('location'), `https://site.example${location}`, path);
  }
  assert.equal(asked.length, 0);
});

test('private app places retain the app shell without a public backend read', async t => {
  const { asked, serve } = backend(t, () => {
    throw Error('must not fetch');
  });
  for (const path of [
    '/account',
    '/signin',
    '/device',
    '/ada/atlas/private',
    '/projects',
    '/settings',
    '/wp-login.php',
  ]) {
    const response = await serve(new Request(`https://site.example${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), APP, path);
  }
  assert.equal(asked.length, 0);
});

test('doubled-leading-slash account addresses reach the ordinary app without public reads', async t => {
  const { asked, serve } = backend(t, () => {
    throw Error('must not fetch');
  });
  const origin = 'https://site.example';
  for (const [path, location] of [
    ['//account', '/account'],
    ['///account/devices?tab=current', '/account/devices?tab=current'],
  ]) {
    assert(isPublicReadPath(`${origin}${path}`), path);
    const response = await serve(new Request(`${origin}${path}`));
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get('location'), `${origin}${location}`, path);
    const account = await serve(new Request(response.headers.get('location')));
    assert.equal(account.status, 200, location);
    assert.equal(account.headers.get('location'), null, location);
    assert.equal(await account.text(), APP, location);
  }
  // Another doubled address is a project page: it is canonicalized like any other, with no read.
  const outside = await serve(new Request(`${origin}//outside/account`));
  assert.equal(outside.status, 308);
  assert.equal(outside.headers.get('location'), `${origin}/outside/account`);
  assert.equal(asked.length, 0);
});

test('share URLs use configuration even on another request host', async t => {
  const { asked, serve } = backend(t, () => json(PAGE));
  const response = await serve(new Request('https://untrusted.example/ada/atlas'));
  const html = await response.text();
  assert.match(html, /https:\/\/site.example\/ada\/atlas/);
  assert.doesNotMatch(html, /untrusted/);
  assert.deepEqual(
    asked.map(call => call.url),
    [`${SITE}/public/v1/project/ada/atlas.json`],
  );
});

test('a missing site address serves the bundled shell without a backend read', async t => {
  const { asked, serve } = backend(
    t,
    () => {
      throw new Error('must not fetch');
    },
    { FORGE_WEB_URL: undefined },
  );
  const response = await serve(new Request('https://untrusted.example/ada/atlas'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), APP);
  assert.equal(asked.length, 0);
});

test('HTML query state stays in the browser while the edge copy uses only page identity', async t => {
  edgeCaches(t);
  const { asked, serve } = backend(t, () => json(PAGE));
  for (const query of ['?q=one', '?q=two&utm_source=test', '?cache=unbounded']) {
    const response = await serve(new Request(`https://site.example/ada/atlas${query}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.match(await response.text(), /ada\/atlas · Forge/);
  }
  assert.equal(asked.length, 1, 'one backend fetch across all query variants; the shell is bundled');
});

for (const failure of [401, 500, 503, 'network', 'invalid-json'])
  test(`public-read ${failure} keeps every HTML front page as the plain app`, async t => {
    const { serve } = backend(t, () =>
      failure === 'network'
        ? new Error('network unavailable')
        : failure === 'invalid-json'
          ? new Response('invalid json')
          : json({ found: false }, failure),
    );
    for (const path of ['/explore', '/ada', '/ada/atlas']) {
      const response = await serve(new Request(`https://site.example${path}`));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), APP);
      assert.match(response.headers.get('content-type'), /text\/html/);
    }
  });

for (const missing of ['FORGE_PUBLIC_READ_SECRET', 'FORGE_CONVEX_SITE_URL'])
  test(`missing ${missing} keeps members on the plain app without a backend call`, async t => {
    const { asked, serve } = backend(
      t,
      () => {
        throw new Error('must not fetch');
      },
      { [missing]: undefined },
    );
    for (const path of ['/explore', '/ada', '/ada/atlas']) {
      const response = await serve(new Request(`https://site.example${path}`));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), APP);
    }
    assert.equal(asked.length, 0);
  });

test('case, encoding and slash variants redirect before any public backend call', async t => {
  const { asked, serve } = backend(t, () => {
    throw new Error('must not fetch');
  });
  for (const [variant, canonical] of [
    ['/ADA/ATLAS', '/ada/atlas'],
    ['/EXPLORE', '/explore'],
    ['/%61da/%61tlas', '/ada/atlas'],
    ['//ada///atlas/', '/ada/atlas'],
    ['//ada/', '/ada'],
    ['/ada/atlas/', '/ada/atlas'],
    ['/SITEMAP.XML/', '/sitemap.xml'],
    ['/-/public/v1/project/ADA/%61tlas.json', '/-/public/v1/project/ada/atlas.json'],
  ]) {
    assert(isPublicReadPath(`https://site.example${variant}`), variant);
    const response = await serve(new Request(`https://site.example${variant}`));
    assert.equal(response.status, 308, variant);
    assert.equal(response.headers.get('location'), `https://site.example${canonical}`, variant);
  }
  assert.equal(asked.length, 0);
  for (const path of ['/ada/atlas/private', '/account/devices/edit', '/llms.txt', '/assets/app.js', '/'])
    assert.equal(isPublicReadPath(`https://site.example${path}`), false, path);
});

test('private or missing data stays an identical 404 on a warm envelope across queries', async t => {
  const { edge, outcomes } = edgeCaches(t);
  const { asked, serve } = backend(t, () => {
    const response = json({ found: false }, 404);
    response.headers.set('access-control-allow-origin', '*');
    return response;
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
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  }
  assert.equal(asked.length, 1);
  assert.deepEqual(edge.puts, [], 'a 404 is never an edge copy');
  outcomes.values.clear();
  await serve(new Request(path));
  assert.equal(asked.length, 2);
});

test('every Worker response carries the site security headers, whatever the upstream sends', async t => {
  const { serve } = backend(t, url => (url.endsWith('/boom.json') ? new Error('down') : json(PAGE)));
  const responses = [
    ...(await Promise.all(
      ['/ada/atlas', '/-/public/v1/explore/active.json', '/ADA', '/-/public/v1/boom.json', '/projects'].map(
        path => serve(new Request(`https://site.example${path}`)),
      ),
    )),
    await serve(new Request('https://site.example/ada', { method: 'POST' })),
    await serve(new Request('https://site.example/auth/device/start-v2', { method: 'GET' })),
  ];
  for (const response of responses)
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      assert.equal(response.headers.get(name), value, `${response.status}: ${name}`);
});

test('a HEAD request gets the status and headers without a body', async t => {
  const { serve } = backend(t, () => json({ found: true }));
  const response = await serve(
    new Request('https://site.example/-/public/v1/explore/active.json', { method: 'HEAD' }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  const app = await serve(new Request('https://site.example/projects', { method: 'HEAD' }));
  assert.equal(app.status, 200);
  assert.equal(app.body, null);
});
