// SPDX-License-Identifier: Apache-2.0
/** The cached public read (Items 6a60e89a, 875a4b60, 8947a779). Signed-out visitors and crawlers of public pages are
 * served from the CDN's durable cache: a hit runs no function and makes no Convex call. On a miss this function asks
 * the backend's public route once (convex/publicHttp.ts) and the CDN keeps the answer for the cache period, so the
 * backend is reached only on misses. Data queries redirect; HTML query state never varies the shared bytes. No visitor credential is forwarded.
 * Failures and missing reads are cached for 30 seconds to absorb repeated retries.
 *
 * It also gives the app page of explore, profiles and public projects its title, description and share-card tags
 * (netlify/lib/public-meta.ts), so link previews and crawlers see them without running the app. */
import type { Config } from '@netlify/functions';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { networkFetch, networkTimeout } from '../../src/network-fetch.js';
import { exploreMeta, profileMeta, projectMeta, withMeta, type PageMeta } from '../lib/public-meta.js';

const SHARED = 'public, durable, s-maxage=30, must-revalidate';
// This parameter is always removed before a read, so every HTML query shares one cache entry.
const PAGE_KEY = '__forge_page';
/** First path segments under /- that are app places, never a profile handle (web/src/app/paths.ts). */
const RESERVED = new Set(['account', 'signin', 'device', 'new', 'public', 'explore', 'terms', 'privacy']);
/** Set on every function response, independent of static-page headers. */
const SECURITY: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'sha256-ex8kSqwf1WiPVL0BhnAXX54XDAjFXEHkC+qlMJg0x4Q=' 'sha256-p2Joqh9y7vaFYpQIDQO6qeRWJS1NU+RqnHs4bxxN1+w=' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://*.clerk.accounts.dev; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src https://challenges.cloudflare.com https://*.clerk.accounts.dev; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};
const unavailable = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': SHARED,
      'netlify-vary': `query=${PAGE_KEY}`,
      'content-type': 'text/plain',
      'x-content-type-options': 'nosniff',
    },
  });

function siteOrigin() {
  const value = process.env.FORGE_WEB_URL ?? process.env.URL;
  return value && /^https:\/\/[a-z0-9.-]+$/i.test(value) ? value : null;
}

function backend() {
  const site = process.env.FORGE_CONVEX_SITE_URL;
  return site && /^https:\/\/[a-z0-9.-]+$/i.test(site) ? site : null;
}

const get = (url: string, headers: Record<string, string> = {}) =>
  networkFetch(url, { redirect: 'error', signal: networkTimeout(8_000), headers }, { retries: 0 });

async function proxy(path: string) {
  const site = backend();
  const key = process.env.FORGE_PUBLIC_READ_SECRET;
  if (!site || !key) return unavailable(503, 'Public reads are not configured.');
  // Keep missing/failure outcomes in successful cache envelopes while preserving their real
  // status for visitors. The Cache API expires them after 30 s, without timers or stale reuse.
  const storage = (globalThis as unknown as { caches?: Pick<CacheStorage, 'open'> }).caches;
  const cache = storage ? await storage.open('forge-public-outcomes-v2') : null;
  const cacheKey = `${site}${path}`;
  const failed = cache ? await cache.match(cacheKey) : null;
  if (failed) {
    if (failed.headers.get('x-forge-public-status') === '404')
      return new Response(failed.body, {
        status: 404,
        headers: {
          'content-type': failed.headers.get('content-type') ?? 'application/json',
          'cache-control': 'public, max-age=0, must-revalidate',
          'netlify-cdn-cache-control': SHARED,
        },
      });
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  const response = await get(cacheKey, { 'x-forge-public-key': key }).catch(() => null);
  if (!response || response.status >= 500 || response.status === 401) {
    if (cache)
      await cache.put(
        cacheKey,
        new Response('unavailable', { headers: { 'cache-control': 'public, max-age=30' } }),
      );
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });
  // Only what the route marked cacheable is kept.
  for (const name of [
    'cache-control',
    'netlify-cdn-cache-control',
    'access-control-allow-origin',
    'x-content-type-options',
  ])
    if (response.headers.get(name)) headers.set(name, response.headers.get(name)!);
  if (response.status === 404) {
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    headers.set('netlify-cdn-cache-control', SHARED);
    if (cache)
      await cache.put(
        cacheKey,
        new Response(await response.clone().text(), {
          headers: {
            'cache-control': 'public, max-age=30',
            'content-type': headers.get('content-type')!,
            'x-forge-public-status': '404',
          },
        }),
      );
  }
  return new Response(response.body, { status: response.status, headers });
}

/** The cached public read behind an app address, when that address is a public page. */
export function readFor(
  pathname: string,
): { json: string; meta: (origin: string, body: never) => PageMeta } | null {
  let parts: string[];
  try {
    parts = pathname
      .split('/')
      .filter(Boolean)
      .slice(1)
      .map(part => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
  if (parts.length === 1 && parts[0] === 'explore')
    return { json: '/-/public/v1/explore/active.json', meta: exploreMeta as never };
  if (parts.length === 1 && !RESERVED.has(parts[0]!))
    return { json: `/-/public/v1/profile/${encodeURIComponent(parts[0]!)}.json`, meta: profileMeta as never };
  if (parts.length === 2 && !RESERVED.has(parts[0]!))
    return {
      json: `/-/public/v1/project/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}.json`,
      meta: projectMeta as never,
    };
  return null;
}

/** This immutable built shell is included in the function, so settings and upstream failures
 * cannot replace a member's app with an error page. No request-controlled self-fetch. */
async function page(origin: string | null, pathname: string) {
  let html = await fs.readFile(join(process.cwd(), 'hosted-web-dist', 'app.html'), 'utf8');
  const read = readFor(pathname);
  if (origin && read) {
    try {
      const data = await proxy(read.json.slice(2));
      // Unavailable, unauthorized, private and missing reads all keep the plain app shell.
      if (data.ok) html = withMeta(html, read.meta(origin, (await data.json()) as never));
    } catch {
      // Metadata is optional; the app must still load when the public read or cache fails.
    }
  }
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'netlify-cdn-cache-control': SHARED,
      'netlify-vary': `query=${PAGE_KEY}`,
    },
  });
}

function canonicalPath(pathname: string) {
  try {
    const path =
      '/' +
      pathname
        .split('/')
        .filter(Boolean)
        .map(part => encodeURIComponent(decodeURIComponent(part).toLowerCase()))
        .join('/');
    return path === '/sitemap.xml' || path.startsWith('/-/public/v1/') || readFor(path) ? path : pathname;
  } catch {
    return pathname;
  }
}

async function respond(request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const url = new URL(request.url);
  const origin = siteOrigin();
  const path = canonicalPath(url.pathname);
  const data = path === '/sitemap.xml' || path.startsWith('/-/public/v1/');
  // Canonicalize before loading the shell or calling the backend. HTML preserves app query state.
  if (path !== url.pathname || (data && url.search) || url.searchParams.has(PAGE_KEY)) {
    if (data) url.search = '';
    else url.searchParams.delete(PAGE_KEY);
    return new Response(null, {
      status: 308,
      headers: {
        location: `${origin ?? ''}${path}${url.search}`,
        'cache-control': 'no-store',
      },
    });
  }
  if (data && !origin) return unavailable(503, 'Public reads are not configured.');
  if (path === '/sitemap.xml') return proxy('/public/v1/sitemap.xml');
  if (path.startsWith('/-/public/v1/')) return proxy(path.slice(2));
  return page(origin, path);
}

export default async (request: Request) => {
  let response: Response;
  try {
    response = await respond(request);
  } catch {
    response = unavailable(502, 'The public read is unavailable; try again.');
  }
  for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
};

export const config: Config = {
  // Include slash/case variants so they reach canonicalization before any public read.
  path: [
    '/:page(\\/*-\\/+[^\\/]+(?:\\/+[^\\/]+)?\\/*)',
    '/-/public/v1/*',
    '/:sitemap(\\/*[sS][iI][tT][eE][mM][aA][pP][.][xX][mM][lL]\\/*)',
  ],
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
