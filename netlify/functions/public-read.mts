// SPDX-License-Identifier: Apache-2.0
/** The cached public read (Items 6a60e89a, 875a4b60, 8947a779). Signed-out visitors and crawlers of public pages are
 * served from the CDN's durable cache: a hit runs no function and makes no Convex call. On a miss this function asks
 * the backend's public route once (convex/publicHttp.ts) and the CDN keeps the answer for the cache period, so the
 * backend is reached only on misses. Ordinary query parameters do not affect the shared bytes. No visitor credential is forwarded;
 * a miss carries only a keyed hash of the visitor's address (src/client-hash.ts) for the per-visitor limit, never the address.
 * Failures and missing reads are cached for 30 seconds to absorb repeated retries.
 *
 * It also gives the app page of explore, profiles and public projects its title, description and share-card tags
 * (netlify/lib/public-meta.ts), so link previews and crawlers see them without running the app. */
import type { Config, Context } from '@netlify/functions';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { networkFetch, networkTimeout } from '../../src/network-fetch.js';
import {
  PUBLIC_CODE_BROWSER,
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  PUBLIC_CODE_SHARED,
  publicCodeFileAddress,
  publicCodeIngressKey,
  publicCodeRemaining,
} from '../../src/public-code-cache.js';
import { reservedHandles } from '../../src/readable-urls.js';
import { CLIENT_HEADER, clientHash } from '../../src/client-hash.js';
import { earlierAppPath, isAppPath, normalizeAccountPathname } from '../../web/src/app/paths.js';
import { exploreMeta, profileMeta, projectMeta, withMeta, type PageMeta } from '../lib/public-meta.js';

const SHARED = PUBLIC_CODE_SHARED;
// Strip this reserved cache selector before reads so ordinary query parameters share one cache entry.
const PAGE_KEY = '__forge_page';
// Netlify copies the incoming query onto a redirect whose target has no query entries.
// One empty entry explicitly clears it; a lone '?' does not. It has no page identity.
const EMPTY_QUERY = '?=';
/** A handle and a project slug (src/readable-urls.ts handleError, src/project-routes.ts slug). Any other shape, such as
 * a probe for /wp-login.php or /.env, is never a public page and never reaches the backend. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** Set on every function response, independent of static-page headers. */
const SECURITY: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'sha256-ex8kSqwf1WiPVL0BhnAXX54XDAjFXEHkC+qlMJg0x4Q=' 'sha256-/bpm5bmsSEb1V97OjNCSeP/6USgbOt6CwVT1lPKPzK4=' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://*.clerk.accounts.dev; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src https://challenges.cloudflare.com https://*.clerk.accounts.dev; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};
const unavailable = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': SHARED,
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

function publicDataHeaders(response: Response, status: number) {
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });
  for (const name of ['cache-control', 'netlify-cdn-cache-control', 'access-control-allow-origin']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (status === 404) {
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    headers.set('netlify-cdn-cache-control', SHARED);
  }
  return headers;
}

function codeWorker(path: string) {
  const worker = process.env.FORGE_PUBLIC_CODE_WORKER_URL;
  return worker && /^https:\/\/[a-z0-9.-]+$/i.test(worker) && publicCodeFileAddress(path) ? worker : null;
}

async function proxy(path: string, client: string | null) {
  const site = backend();
  const key = process.env.FORGE_PUBLIC_READ_SECRET;
  if (!site || !key) return unavailable(503, 'Public reads are not configured.');
  // Keep missing/failure outcomes in successful cache envelopes while preserving their real
  // status for visitors. The Cache API expires them after 30 s, without timers or stale reuse.
  const storage = (globalThis as unknown as { caches?: Pick<CacheStorage, 'open'> }).caches;
  const cache = storage ? await storage.open('forge-public-outcomes-v3') : null;
  const cacheKey = `${site}${path}`;
  const failed = cache ? await cache.match(cacheKey) : null;
  if (failed) {
    if (failed.headers.get('x-forge-public-status') === '404')
      return new Response(failed.body, {
        status: 404,
        headers: publicDataHeaders(failed, 404),
      });
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  const worker = codeWorker(path);
  const visitor: Record<string, string> = client ? { [CLIENT_HEADER]: client } : {};
  // A Worker timeout may arrive after an origin call. In that case the existing failure
  // response is the only safe continuation within the one-attempt public read budget.
  const response = await (
    worker
      ? get(worker + path, { [PUBLIC_CODE_INGRESS]: await publicCodeIngressKey(key), ...visitor })
      : get(cacheKey, { 'x-forge-public-key': key, ...visitor })
  ).catch(() => null);
  if (!response || response.status >= 500 || response.status === 401) {
    if (cache)
      await cache.put(
        cacheKey,
        new Response('unavailable', { headers: { 'cache-control': 'public, max-age=30' } }),
      );
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  const headers = publicDataHeaders(response, response.status);
  if (worker && response.ok) {
    const seconds = Math.floor(publicCodeRemaining(Number(response.headers.get(PUBLIC_CODE_EXPIRY))) / 1000);
    headers.set('cache-control', seconds > 0 ? PUBLIC_CODE_BROWSER : 'no-store');
    headers.set(
      'netlify-cdn-cache-control',
      seconds > 0 ? `public, durable, s-maxage=${seconds}, must-revalidate` : 'no-store',
    );
    const delivery = response.headers.get(PUBLIC_CODE_DELIVERY);
    if (delivery === 'edge' || delivery === 'r2' || delivery === 'origin')
      headers.set(PUBLIC_CODE_DELIVERY, delivery);
  }
  if (response.status === 404 && cache) {
    const envelope = new Headers(headers);
    envelope.set('cache-control', 'public, max-age=30');
    envelope.delete('netlify-cdn-cache-control');
    envelope.set('x-forge-public-status', '404');
    await cache.put(cacheKey, new Response(await response.clone().arrayBuffer(), { headers: envelope }));
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
      .map(part => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
  const [first = '', second] = parts;
  if (parts.length === 1 && first === 'explore')
    return { json: '/-/public/v1/explore/active.json', meta: exploreMeta as never };
  if (!HANDLE.test(first) || reservedHandles.has(first)) return null;
  if (parts.length === 1)
    return { json: `/-/public/v1/profile/${encodeURIComponent(first)}.json`, meta: profileMeta as never };
  if (parts.length === 2 && SLUG.test(second!))
    return {
      json: `/-/public/v1/project/${encodeURIComponent(first)}/${encodeURIComponent(second!)}.json`,
      meta: projectMeta as never,
    };
  return null;
}

/** This immutable built shell is included in the function, so settings and upstream failures
 * cannot replace a member's app with an error page. No request-controlled self-fetch. */
async function page(origin: string | null, pathname: string, client: string | null) {
  let html = await fs.readFile(join(process.cwd(), 'hosted-web-dist', 'app.html'), 'utf8');
  const read = readFor(pathname);
  if (origin && read) {
    try {
      const data = await proxy(read.json.slice(2), client);
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

async function respond(request: Request, client: string | null) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const url = new URL(request.url);
  const origin = siteOrigin();
  const path = canonicalPath(normalizeAccountPathname(url.pathname));
  const data = path === '/sitemap.xml' || path.startsWith('/-/public/v1/');
  // A page address from before the switch to the root (Item b0704959) moves for good, keeping its query, and always
  // to this site: the Location is absolute and the path starts with exactly one "/".
  const earlier = data ? null : earlierAppPath(path);
  if (earlier)
    return new Response(null, {
      status: 301,
      headers: { location: `${origin ?? url.origin}${earlier}${url.search}`, 'cache-control': 'no-store' },
    });
  if (!data && !isAppPath(path))
    return new Response(
      '<!doctype html><html><head><title>Not found · Forge</title></head><body><h1>Page not found</h1></body></html>',
      {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      },
    );
  // Canonicalize the path and remove the reserved selector. The proxy reads by path alone.
  if (path !== url.pathname || url.searchParams.has(PAGE_KEY)) {
    const hadQuery = Boolean(url.search);
    if (url.searchParams.has(PAGE_KEY)) url.searchParams.delete(PAGE_KEY);
    return new Response(null, {
      status: 308,
      headers: {
        location: `${origin ?? ''}${path}${url.search || (hadQuery ? EMPTY_QUERY : '')}`,
        'cache-control': 'no-store',
      },
    });
  }
  if (data && !origin) return unavailable(503, 'Public reads are not configured.');
  if (path === '/sitemap.xml') return proxy('/public/v1/sitemap.xml', client);
  if (path.startsWith('/-/public/v1/')) return proxy(path.slice(2), client);
  return page(origin, path, client);
}

export default async (request: Request, context?: Context) => {
  let response: Response;
  try {
    response = await respond(request, await clientHash(process.env.FORGE_CLIENT_HASH_KEY, context?.ip));
  } catch {
    response = unavailable(502, 'The public read is unavailable; try again.');
  }
  for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
  // Cacheable requests never carry PAGE_KEY, so ordinary query variants share one object per path.
  response.headers.set('netlify-vary', `query=${PAGE_KEY}`);
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
};

export const config: Config = {
  // Every one- or two-segment page address, with slash/case variants, so they reach canonicalization before any
  // public read; a name with a dot is a file. The site's own folders (docs, assets) are excluded, never preferStatic:
  // with the netlify.toml "/*" -> /app.html rewrite, preferStatic served the app shell for every path, this one too
  // (dev, receipt f1da4770: /-/public/v1/ returned HTML).
  path: [
    '/:page(\\/*[^\\/.]+(?:\\/+[^\\/.]+)?\\/*)',
    // The cached reads under /-/public/v1/, and the 301 for every other earlier /-/ address (netlify.toml has none).
    '/-/*',
    '/:sitemap(\\/*[sS][iI][tT][eE][mM][aA][pP][.][xX][mM][lL]\\/*)',
  ],
  excludedPath: ['/docs', '/docs/*', '/assets', '/assets/*'],
  // Native enforcement precedes handler redirects, but its distributed count can lag.
  // Keep it at the platform: no per-request shared counter or additional I/O.
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
