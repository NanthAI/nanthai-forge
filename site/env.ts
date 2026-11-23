// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFetch } from '../src/network-fetch';

/** The site Worker's bindings (scripts/build-site.mjs declares them). Settings are Worker secrets, so an unset one is
 * undefined and the route that needs it answers "not configured". */
export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type SiteEnv = {
  /** The built web app (hosted-web-dist), served by the platform before the Worker runs. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Per-address backstops (Cloudflare's rate-limit binding, counted per location); absent in tests. */
  PUBLIC_LIMIT?: RateLimit;
  DEVICE_LIMIT?: RateLimit;
  FORGE_WEB_URL?: string;
  FORGE_CONVEX_SITE_URL?: string;
  FORGE_PUBLIC_READ_SECRET?: string;
  FORGE_PUBLIC_CODE_WORKER_URL?: string;
  FORGE_CLIENT_HASH_KEY?: string;
  FORGE_SITE_DEVICE_KEY?: string;
};
export type SiteContext = { waitUntil(promise: Promise<unknown>): void };

/** One attempt at a backend, never following a redirect: workerd has no `redirect: 'error'`, so a redirect is
 * refused here and the site's keys only ever reach the address they were sent to. */
export async function siteFetch(url: string, init: RequestInit & { signal: AbortSignal }) {
  const response = await networkFetch(url, { ...init, redirect: 'manual' }, { retries: 0 });
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new Error('redirect refused');
  }
  return response;
}

/** True when this address is over its platform window. A limiter error never blocks a visitor. */
export async function limited(limiter: RateLimit | undefined, ip: string | null) {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key: ip ?? 'unknown' })).success;
  } catch {
    return false;
  }
}
