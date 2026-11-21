// SPDX-License-Identifier: Apache-2.0
import {
  PUBLIC_CODE_DELIVERY,
  PUBLIC_CODE_EXPIRY,
  PUBLIC_CODE_INGRESS,
  PUBLIC_CODE_JSON,
  PUBLIC_CODE_SHARED,
  PUBLIC_CODE_TTL_MS,
  publicCodeDigest,
  publicCodeFileAddress,
  publicCodeRemaining,
} from './public-code-cache.js';
import { networkFetch, networkTimeout } from './network-fetch.js';

type Replica = {
  get(key: string): Promise<{ body: ReadableStream; customMetadata?: Record<string, string> } | null>;
  put(key: string, body: string, options: { customMetadata: Record<string, string> }): Promise<unknown>;
};
type Bindings = {
  REPLICA: Replica;
  FORGE_CONVEX_SITE_URL: string;
  FORGE_PUBLIC_READ_SECRET: string;
  FORGE_PUBLIC_CODE_WORKER_KEY: string;
};

function validKey(expected: string, supplied: string | null) {
  if (expected?.length !== 64 || supplied?.length !== 64) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) different |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return different === 0;
}

function renderedFile(body: string) {
  try {
    return JSON.parse(body)?.file?.available === true;
  } catch {
    return false;
  }
}

function retainedHeaders(expiresAt: number) {
  return new Headers({
    'content-type': PUBLIC_CODE_JSON,
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    [PUBLIC_CODE_EXPIRY]: String(expiresAt),
  });
}

function clientResponse(response: Response, layer: 'edge' | 'r2' | 'origin') {
  const headers = new Headers({ 'cache-control': 'private, no-store', [PUBLIC_CODE_DELIVERY]: layer });
  for (const name of ['content-type', 'x-content-type-options', 'access-control-allow-origin']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const expiry = response.headers.get(PUBLIC_CODE_EXPIRY);
  if (expiry && publicCodeRemaining(Number(expiry)) > 0) headers.set(PUBLIC_CODE_EXPIRY, expiry);
  return new Response(response.body, { status: response.status, headers });
}

function writeEdge(cache: Cache, key: Request, body: BodyInit | null, expiresAt: number) {
  const seconds = Math.floor(publicCodeRemaining(expiresAt) / 1000);
  const headers = retainedHeaders(expiresAt);
  headers.set('cache-control', `public, max-age=${seconds}, must-revalidate`);
  return seconds > 0 ? cache.put(key, new Response(body, { headers })).catch(() => {}) : Promise.resolve();
}

async function serve(request: Request, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }) {
  const { origin, pathname, search } = new URL(request.url);
  const refuse = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
  if (!validKey(env.FORGE_PUBLIC_CODE_WORKER_KEY, request.headers.get(PUBLIC_CODE_INGRESS)))
    return refuse(401);
  if (request.method !== 'GET') return refuse(405);
  if (search || !publicCodeFileAddress(pathname)) return refuse(404);

  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new Request(origin + pathname);
  const cached = await cache.match(key).catch(() => undefined);
  if (cached && publicCodeRemaining(Number(cached.headers.get(PUBLIC_CODE_EXPIRY))) > 0)
    return clientResponse(cached, 'edge');

  const replicaKey = `v1/${await publicCodeDigest(pathname)}`;
  const stored = await env.REPLICA.get(replicaKey).catch(() => null);
  const storedExpiry = Number(stored?.customMetadata?.expiresAt);
  if (stored && publicCodeRemaining(storedExpiry) > 0) {
    const reply = new Response(stored.body, { headers: retainedHeaders(storedExpiry) });
    ctx.waitUntil(writeEdge(cache, key, reply.clone().body, storedExpiry));
    return clientResponse(reply, 'r2');
  }
  if (stored) await stored.body.cancel().catch(() => {});

  const site = env.FORGE_CONVEX_SITE_URL;
  if (!env.FORGE_PUBLIC_READ_SECRET || !/^https:\/\/[a-z0-9.-]+$/i.test(site)) return refuse(503);
  const expiresAt = Date.now() + PUBLIC_CODE_TTL_MS;
  const response = await networkFetch(
    site + pathname,
    {
      redirect: 'manual',
      cache: 'no-store',
      signal: networkTimeout(7_000),
      headers: { 'x-forge-public-key': env.FORGE_PUBLIC_READ_SECRET },
    },
    { retries: 0 },
  ).catch(() => null);
  if (!response) return refuse(502);
  // Workerd supports manual redirects. Refuse them here so the origin key only reaches Convex.
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    return refuse(502);
  }
  if (
    response.status !== 200 ||
    response.headers.get('content-type') !== PUBLIC_CODE_JSON ||
    response.headers.get('netlify-cdn-cache-control') !== PUBLIC_CODE_SHARED ||
    response.headers.has('set-cookie')
  )
    return clientResponse(response, 'origin');

  const body = await response.text().catch(() => null);
  if (body === null) return refuse(502);
  if (publicCodeRemaining(expiresAt) > 0 && renderedFile(body)) {
    ctx.waitUntil(
      Promise.allSettled([
        writeEdge(cache, key, body, expiresAt),
        env.REPLICA.put(replicaKey, body, { customMetadata: { expiresAt: String(expiresAt) } }),
      ]),
    );
  }
  return clientResponse(new Response(body, { headers: retainedHeaders(expiresAt) }), 'origin');
}

export default { fetch: serve };
