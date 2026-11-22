// SPDX-License-Identifier: Apache-2.0
import { networkFetch, networkTimeout } from './network-fetch.js';
import { deploymentUrl } from './deployment-origin.js';

/** A device sign-in start or renewal (Item b6588425). A deployment whose sign-ins go through its site answers a direct
 * call with 421 `use_site` and the site's origin, and the same signed request is sent there once: the site adds the
 * per-visitor limit, and the proof still names the backend origin it was signed for. An older environment answers
 * directly, as before. Nothing is stored. */
export async function devicePost(backend: string, operation: 'start-v2' | 'renew', body: string) {
  const send = (origin: string) =>
    networkFetch(`${origin}/auth/device/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: networkTimeout(15_000),
    });
  const direct = await send(backend);
  if (direct.status !== 421) return direct;
  let site: string | null = null;
  try {
    const reply = (await direct.clone().json()) as { error?: unknown; site?: unknown };
    if (reply.error === 'use_site' && typeof reply.site === 'string') site = deploymentUrl(reply.site);
  } catch {
    site = null;
  }
  return site && site !== backend ? send(site) : direct;
}

/** The server's own words for a refused sign-in, when it gave them (a short single line). */
export function deviceRefusal(reply: unknown) {
  const text = (reply as { error_description?: unknown } | null)?.error_description;
  return typeof text === 'string' && text.length <= 300 && !/[\u0000-\u001f]/.test(text) ? text : null;
}
