// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The cached public read (Items 6a60e89a, 875a4b60, 8947a779). Signed-out visitors and crawlers of public pages are
 * served from the site's edge cache: a hit makes no Convex call. Discovery can read one R2 snapshot when bound;
 * the deployed reader is still unbound. On a legacy miss this asks the backend's public route once
 * (convex/publicHttp.ts) and the edge keeps the answer for the period the backend allows (s-maxage), so the backend is
 * reached only on misses. Cloudflare's cache is per location, so each location fills once per period. Query parameters
 * do not affect the shared bytes: the cache key is the canonical path. No visitor credential is forwarded; a miss
 * carries only a keyed hash of the visitor's address (src/client-hash.ts) for the per-visitor limit, never the address.
 * Failures and missing reads are cached for 30 seconds to absorb repeated retries.
 *
 * It also gives the app page of explore, profiles and public projects its title, description and share-card tags
 * (site/public-meta.ts), so link previews and crawlers see them without running the app. */
import { networkTimeout } from '../src/network-fetch';
import {
  PUBLIC_CODE_BROWSER,
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  publicCodeFileAddress,
  publicCodeIngressKey,
  publicCodeRemaining,
} from '../src/public-code-cache';
import { reservedHandles } from '../src/readable-urls';
import { HANDLE, SLUG, snapshotCacheUrl } from '../src/public-snapshot-contract';
import { CLIENT_HEADER, clientHash } from '../src/client-hash';
import { earlierAppPath, isAppPath, normalizeAccountPathname } from '../web/src/app/paths';
import { exploreMeta, profileMeta, projectMeta, withMeta, type PageMeta } from './public-meta';
import { limited, siteFetch, type SiteContext, type SiteEnv } from './env';
import { readSitemap, readSnapshot, snapshotAddress, withSnapshot } from './public-snapshots';

/** The backend marks a shareable public answer with this header (convex/publicHttp.ts PUBLIC_CACHE.shared). */
const UPSTREAM_SHARED = 'netlify-cdn-cache-control';
/** Seconds the edge may keep this response; internal, never sent to a visitor. */
const EDGE_SECONDS = 'x-forge-edge-seconds';
/** The visitor's own cache-control, kept beside the edge copy's. */
const BROWSER_CACHE = 'x-forge-browser-cache-control';
/** The snapshot cache stores misses in 200 envelopes; visitors see the original status. */
const EDGE_MISSING = 'x-forge-edge-missing';
const FAILURE_SECONDS = 30;
/** Every one- or two-segment page address, with slash/case variants, so they reach canonicalization before any public
 * read; a name with a dot is a file. The cached reads under /-/public/v1/, the 301 for every other earlier /-/
 * address, and the sitemap. Static files are served before the Worker runs; the site's own folders are excluded so a
 * missing file there gets the app, never a public read. Matched against the URL's (still percent-encoded) path. */
const PUBLIC_READ_PATHS = [
  /^\/+[^/.]+(?:\/+[^/.]+)?\/*$/,
  /^\/-\//,
  /^\/+[sS][iI][tT][eE][mM][aA][pP][.][xX][mM][lL]\/*$/,
];
const PUBLIC_READ_EXCLUDED = /^\/(?:docs|assets)(?:\/|$)/;
export const isPublicReadPath = (url: string) => {
  const { pathname } = new URL(url);
  return PUBLIC_READ_PATHS.some(pattern => pattern.test(pathname)) && !PUBLIC_READ_EXCLUDED.test(pathname);
};

const edge = (response: Response, seconds: number) => {
  if (seconds > 0) response.headers.set(EDGE_SECONDS, String(seconds));
  return response;
};
const unavailable = (status: number, body: string) =>
  edge(
    new Response(body, {
      status,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain',
        'x-content-type-options': 'nosniff',
      },
    }),
    FAILURE_SECONDS,
  );
const sharedSeconds = (value: string | null) => {
  const seconds = Number(/(?:^|,)\s*s-maxage=(\d+)/.exec(value ?? '')?.[1] ?? 0);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
};
const httpsOrigin = (value: string | undefined) =>
  value && /^https:\/\/[a-z0-9.-]+$/i.test(value) ? value : null;

const get = (url: string, headers: Record<string, string> = {}) =>
  siteFetch(url, { signal: networkTimeout(8_000), headers });

function publicDataHeaders(response: Response, status: number) {
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });
  for (const name of ['cache-control', 'access-control-allow-origin']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (status === 404) headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return headers;
}

function codeWorker(env: SiteEnv, path: string) {
  const worker = httpsOrigin(env.FORGE_PUBLIC_CODE_WORKER_URL);
  return worker && publicCodeFileAddress(path) ? worker : null;
}

/** Who is reading: the address for the platform backstop and, on demand, its keyed hash for the backend. */
type Visitor = { ip: string | null; hash: () => Promise<string | null> };
const tooMany = () =>
  new Response('Too many requests; try again in a minute.', {
    status: 429,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain', 'retry-after': '60' },
  });

// Keep malformed discovery URLs on the snapshot path too, so they cannot fall through to the legacy fill.
const firstSearch = '/-/public/v1/search/1.json';
const sitemapPath = '/sitemap.xml';
const upstreamSitemap = '/public/v1/sitemap.xml';
const isSitemap = (path: string) => path === sitemapPath || path === `/-${upstreamSitemap}`;
const legacyExplore = '/-/public/v1/explore/active.json';
const searchRoute = (path: string) => /^\/public\/v1\/search(?:\/|$)/.test(path);
const snapshotRoute = (path: string) =>
  searchRoute(path) || /^\/public\/v1\/(?:project|explore|profile)(?:\/|$)/.test(path);
const missingSnapshot = () =>
  new Response('{"found":false}', {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });

async function proxy(env: SiteEnv, path: string, visitor: Visitor) {
  const site = httpsOrigin(env.FORGE_CONVEX_SITE_URL);
  const key = env.FORGE_PUBLIC_READ_SECRET;
  if (!site || !key) return unavailable(503, 'Public reads are not configured.');
  // Keep missing/failure outcomes in successful cache envelopes while preserving their real
  // status for visitors. The Cache API expires them after 30 s, without timers or stale reuse.
  const storage = (globalThis as unknown as { caches?: Pick<CacheStorage, 'open'> }).caches;
  // The cache only saves reads: a cache that fails is a miss, and a copy that cannot be stored is not kept.
  const cache = storage ? await storage.open('forge-public-outcomes-v3').catch(() => null) : null;
  const cacheKey = `${site}${path}`;
  const failed = cache ? await cache.match(cacheKey).catch(() => undefined) : undefined;
  if (failed) {
    if (failed.headers.get('x-forge-public-status') === '404')
      return edge(
        new Response(failed.body, { status: 404, headers: publicDataHeaders(failed, 404) }),
        FAILURE_SECONDS,
      );
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  // The platform backstop counts only requests that would reach the backend.
  if (await limited(env.PUBLIC_LIMIT, visitor.ip)) return tooMany();
  const worker = codeWorker(env, path);
  const client = await visitor.hash();
  const forwarded: Record<string, string> = client ? { [CLIENT_HEADER]: client } : {};
  // A Worker timeout may arrive after an origin call. In that case the existing failure
  // response is the only safe continuation within the one-attempt public read budget.
  const response = await (
    worker
      ? get(worker + path, { [PUBLIC_CODE_INGRESS]: await publicCodeIngressKey(key), ...forwarded })
      : get(cacheKey, { 'x-forge-public-key': key, ...forwarded })
  ).catch(() => null);
  if (!response || response.status >= 500 || response.status === 401) {
    if (cache)
      await cache
        .put(
          cacheKey,
          new Response('unavailable', { headers: { 'cache-control': `public, max-age=${FAILURE_SECONDS}` } }),
        )
        .catch(() => {});
    return unavailable(502, 'The public read is unavailable; try again.');
  }
  const headers = publicDataHeaders(response, response.status);
  let seconds =
    response.status === 404 ? FAILURE_SECONDS : sharedSeconds(response.headers.get(UPSTREAM_SHARED));
  if (worker && response.ok) {
    seconds = Math.floor(publicCodeRemaining(Number(response.headers.get(PUBLIC_CODE_EXPIRY))) / 1000);
    headers.set('cache-control', seconds > 0 ? PUBLIC_CODE_BROWSER : 'no-store');
    const delivery = response.headers.get(PUBLIC_CODE_DELIVERY);
    if (delivery === 'edge' || delivery === 'r2' || delivery === 'origin')
      headers.set(PUBLIC_CODE_DELIVERY, delivery);
  }
  if (response.status === 404 && cache) {
    const envelope = new Headers(headers);
    envelope.set('cache-control', `public, max-age=${FAILURE_SECONDS}`);
    envelope.set('x-forge-public-status', '404');
    await cache
      .put(cacheKey, new Response(await response.clone().arrayBuffer(), { headers: envelope }))
      .catch(() => {});
  }
  return edge(new Response(response.body, { status: response.status, headers }), Math.max(0, seconds));
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
  if (parts.length === 1 && first === 'explore') return { json: legacyExplore, meta: exploreMeta as never };
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

/** The built app shell from the site's own static files (never a request-controlled fetch), so settings and upstream
 * failures cannot replace a member's app with an error page. */
export async function appShell(env: SiteEnv, url: URL) {
  const shell = await env.ASSETS.fetch(new Request(new URL('/app', url.origin)));
  if (!shell.ok) throw new Error('The app shell is missing from the static files.');
  return shell.text();
}

async function page(env: SiteEnv, origin: string | null, url: URL, path: string, visitor: Visitor) {
  let html = await appShell(env, url);
  const read = readFor(path);
  let seconds = FAILURE_SECONDS;
  let status = 200;
  if (origin && read) {
    const path = read.json.slice(2);
    const address = env.PUBLIC_PAGES && snapshotAddress(path);
    try {
      if (env.PUBLIC_PAGES && address) {
        if (await limited(env.PUBLIC_LIMIT, visitor.ip)) seconds = 0;
        else {
          const snapshot = await readSnapshot(env.PUBLIC_PAGES, address);
          if (snapshot) html = withMeta(html, read.meta(origin, snapshot.data as never));
          else status = 404;
          html = withSnapshot(html, path.slice('/public/v1/'.length), snapshot);
        }
      } else if (!env.PUBLIC_PAGES) {
        const data = await proxy(env, path, visitor);
        if (data.ok) html = withMeta(html, read.meta(origin, (await data.json()) as never));
      }
    } catch {
      // Metadata is optional; a missing or invalid object must not stop the signed-in app.
      if (env.PUBLIC_PAGES) seconds = 0;
    }
  }
  return edge(
    new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    }),
    seconds,
  );
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

async function respond(request: Request, env: SiteEnv, url: URL, visitor: Visitor) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const origin = httpsOrigin(env.FORGE_WEB_URL);
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
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  // Canonicalize the path. The proxy reads by path alone.
  if (path !== url.pathname)
    return new Response(null, {
      status: 308,
      headers: { location: `${origin ?? ''}${path}${url.search}`, 'cache-control': 'no-store' },
    });
  if (data && !origin) return unavailable(503, 'Public reads are not configured.');
  if (isSitemap(path)) {
    if (!env.PUBLIC_PAGES) return proxy(env, upstreamSitemap, visitor);
    if (await limited(env.PUBLIC_LIMIT, visitor.ip)) return tooMany();
    const xml = await readSitemap(env.PUBLIC_PAGES, origin!);
    return xml
      ? edge(
          new Response(xml, {
            headers: {
              'content-type': 'application/xml; charset=utf-8',
              'cache-control': 'public, max-age=0, must-revalidate',
            },
          }),
          FAILURE_SECONDS,
        )
      : edge(missingSnapshot(), FAILURE_SECONDS);
  }
  if (path.startsWith('/-/public/v1/')) {
    const upstream = path.slice(2);
    if (!env.PUBLIC_PAGES && searchRoute(upstream))
      return path === firstSearch ? proxy(env, legacyExplore.slice(2), visitor) : missingSnapshot();
    if (!env.PUBLIC_PAGES || !snapshotRoute(upstream)) return proxy(env, upstream, visitor);
    const address = snapshotAddress(upstream);
    if (!address) return missingSnapshot();
    if (await limited(env.PUBLIC_LIMIT, visitor.ip)) return tooMany();
    const snapshot = await readSnapshot(env.PUBLIC_PAGES, address);
    if (!snapshot) return edge(missingSnapshot(), FAILURE_SECONDS);
    return edge(
      new Response(snapshot.json, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=0, must-revalidate',
          'access-control-allow-origin': '*',
        },
      }),
      FAILURE_SECONDS,
    );
  }
  return page(env, origin, url, path, visitor);
}

/** The edge copy keeps the visitor's own cache-control beside the edge lifetime, restored on a hit. */
function forEdge(response: Response, seconds: number) {
  const headers = new Headers(response.headers);
  headers.set(BROWSER_CACHE, headers.get('cache-control') ?? '');
  headers.set('cache-control', `public, max-age=${seconds}`);
  if (response.status === 404) headers.set(EDGE_MISSING, '1');
  return new Response(response.body, { headers });
}
function fromEdge(response: Response) {
  const headers = new Headers(response.headers);
  const browser = headers.get(BROWSER_CACHE);
  const status = headers.get(EDGE_MISSING) === '1' ? 404 : response.status;
  headers.delete(BROWSER_CACHE);
  headers.delete(EDGE_MISSING);
  if (browser) headers.set('cache-control', browser);
  else headers.delete('cache-control');
  return new Response(response.body, { status, headers });
}

export async function publicRead(request: Request, env: SiteEnv, ip: string | null, ctx?: SiteContext) {
  const url = new URL(request.url);
  // A shared edge entry per canonical path: ordinary query parameters share one object (they stay in the browser).
  const snapshot =
    env.PUBLIC_PAGES &&
    (isSitemap(url.pathname) ||
      readFor(url.pathname) ||
      (url.pathname.startsWith('/-/') && snapshotRoute(url.pathname.slice(2))));
  const canonical = snapshot ? httpsOrigin(env.FORGE_WEB_URL) : url.origin;
  // Only the purge authority's hostname can serve a bound snapshot. Aliases cannot retain
  // independent copies, and a missing canonical binding must not create unpurgeable cache entries.
  if (!canonical) return unavailable(503, 'Public reads are not configured.');
  if (snapshot && canonical !== url.origin)
    return new Response(null, {
      status: 308,
      headers: { location: `${canonical}${url.pathname}${url.search}`, 'cache-control': 'no-store' },
    });
  const legacyPath = !env.PUBLIC_PAGES && url.pathname === firstSearch ? legacyExplore : url.pathname;
  const key = snapshot
    ? snapshotCacheUrl(canonical, isSitemap(url.pathname) ? sitemapPath : url.pathname)
    : `${url.origin}${legacyPath}`;
  const storage = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  const cache = request.method === 'GET' || request.method === 'HEAD' ? storage?.default : undefined;
  let response: Response;
  try {
    const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
    if (hit) response = fromEdge(hit);
    else {
      response = await respond(request, env, url, {
        ip,
        hash: () => clientHash(env.FORGE_CLIENT_HASH_KEY, ip),
      });
      const seconds = Number(response.headers.get(EDGE_SECONDS) ?? 0);
      response.headers.delete(EDGE_SECONDS);
      if (cache && seconds > 0 && (response.status === 200 || (snapshot && response.status === 404))) {
        const [body, copy] = response.body ? response.body.tee() : [null, null];
        const stored = cache.put(key, forEdge(new Response(copy, response), seconds)).catch(() => {});
        response = new Response(body, response);
        if (ctx) ctx.waitUntil(stored);
        else await stored;
      }
    }
  } catch {
    response = unavailable(502, 'The public read is unavailable; try again.');
    response.headers.delete(EDGE_SECONDS);
  }
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
