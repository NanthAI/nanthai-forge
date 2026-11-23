// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Device sign-in start and renewal through the site (Item b6588425). Cloudflare reports the client address in
 * CF-Connecting-IP; this forwards only its keyed hash (src/client-hash.ts) with the site's device key, and the backend
 * charges that visitor before its deployment budget (convex/visitorBudget.ts). The address is never stored, logged or
 * forwarded. The body and the backend reply pass through unchanged; the CLI's signed proof names the backend origin,
 * so it still holds. */
import { networkTimeout } from '../src/network-fetch';
import { CLIENT_HEADER, SITE_DEVICE_HEADER, clientHash } from '../src/client-hash';
import { limited, siteFetch, type SiteEnv } from './env';

export const DEVICE_PATHS = ['/auth/device/start-v2', '/auth/device/renew'];

const reply = (status: number, error: string) =>
  Response.json(
    { error, error_description: 'Device sign-in is unavailable here; try again.' },
    { status, headers: { 'cache-control': 'no-store' } },
  );

export async function deviceAuth(request: Request, env: SiteEnv, ip: string | null) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  // A platform backstop before any backend call; the per-visitor windows are counted by the backend.
  if (await limited(env.DEVICE_LIMIT, ip)) return reply(429, 'slow_down');
  const backend = env.FORGE_CONVEX_SITE_URL;
  const key = env.FORGE_SITE_DEVICE_KEY;
  const client = await clientHash(env.FORGE_CLIENT_HASH_KEY, ip);
  if (!backend || !/^https:\/\/[a-z0-9.-]+$/i.test(backend) || !key || !client)
    return reply(503, 'not_configured');
  const operation = new URL(request.url).pathname.endsWith('/renew') ? 'renew' : 'start-v2';
  const response = await siteFetch(`${backend}/auth/device/${operation}`, {
    method: 'POST',
    // A retry reuses the operation id; the CLI waits 15 seconds (src/device-endpoint.ts).
    signal: networkTimeout(9_000),
    headers: { 'content-type': 'application/json', [SITE_DEVICE_HEADER]: key, [CLIENT_HEADER]: client },
    body: await request.text(),
  }).catch(() => null);
  if (!response) return reply(502, 'unavailable');
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
