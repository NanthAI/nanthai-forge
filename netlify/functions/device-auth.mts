// SPDX-License-Identifier: Apache-2.0
/** Device sign-in start and renewal through the site (Item b6588425). The platform reports the client address; this
 * forwards only its keyed hash (src/client-hash.ts) with the site's device key, and the backend charges that visitor
 * before its deployment budget (convex/visitorBudget.ts). The address is never stored, logged or forwarded. The body
 * and the backend reply pass through unchanged; the CLI's signed proof names the backend origin, so it still holds. */
import type { Config, Context } from '@netlify/functions';
import { networkFetch, networkTimeout } from '../../src/network-fetch.js';
import { CLIENT_HEADER, SITE_DEVICE_HEADER, clientHash } from '../../src/client-hash.js';

const reply = (status: number, error: string) =>
  Response.json(
    { error, error_description: 'Device sign-in is unavailable here; try again.' },
    {
      status,
      headers: { 'cache-control': 'no-store' },
    },
  );

export default async (request: Request, context: Context) => {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const backend = process.env.FORGE_CONVEX_SITE_URL;
  const key = process.env.FORGE_SITE_DEVICE_KEY;
  const client = await clientHash(process.env.FORGE_CLIENT_HASH_KEY, context.ip);
  if (!backend || !/^https:\/\/[a-z0-9.-]+$/i.test(backend) || !key || !client)
    return reply(503, 'not_configured');
  const operation = new URL(request.url).pathname.endsWith('/renew') ? 'renew' : 'start-v2';
  const response = await networkFetch(
    `${backend}/auth/device/${operation}`,
    {
      method: 'POST',
      redirect: 'error',
      // Under the platform's 10-second limit for a synchronous function; a retry reuses the operation id.
      signal: networkTimeout(9_000),
      headers: { 'content-type': 'application/json', [SITE_DEVICE_HEADER]: key, [CLIENT_HEADER]: client },
      body: await request.text(),
    },
    { retries: 0 },
  ).catch(() => null);
  if (!response) return reply(502, 'unavailable');
  return new Response(response.body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
};

export const config: Config = {
  path: ['/auth/device/start-v2', '/auth/device/renew'],
  method: 'POST',
  // A platform backstop before any backend call; the per-visitor windows are counted by the backend.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
