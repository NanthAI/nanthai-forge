// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { convexFetch, networkTimeout } from './networkFetch';
import { invariant } from '../src/errors';
import { snapshotCacheUrl } from '../src/public-snapshot-contract';

type PurgeConfig = { zone: string; token: string; origin: string };

/** A deployment with no edge purge binding may opt in to `FORGE_PUBLIC_SNAPSHOT_PURGE=ttl`: it then
 * relies on the Worker's 30-second edge lifetime instead of a purge call. The second step waits 60 seconds,
 * so a copy cached by a read that began before the tombstone has expired too. A binding always wins. */
export const ttlPurge = () =>
  process.env.FORGE_PUBLIC_SNAPSHOT_PURGE === 'ttl' &&
  !process.env.FORGE_PUBLIC_SNAPSHOT_ZONE &&
  !process.env.FORGE_PUBLIC_SNAPSHOT_PURGE_TOKEN;
export const purgeWaitMs = () => (ttlPurge() ? 60_000 : 30_000);

/** Purge exactly the entries the Worker caches. Only the fixed Cloudflare API receives the token.
 * A non-success is not completion; keep the R2 fence and retry this same page of keys. */
export async function purgePublicSnapshotCache(config: PurgeConfig, paths: readonly string[]) {
  invariant(
    /^[a-f0-9]{32}$/.test(config.zone) &&
      /^https:\/\/[a-z0-9.-]+$/.test(config.origin) &&
      paths.length <= 30 &&
      paths.every(path => /^\/[a-z0-9.-]+(?:\/[a-z0-9.-]+)*$/.test(path)),
    'BAD_ARGUMENT',
    'Public snapshot purge requires a site and a bounded page of canonical paths.',
  );
  if (!paths.length) return;
  let ok = false;
  try {
    const response = await convexFetch(
      `https://api.cloudflare.com/client/v4/zones/${config.zone}/purge_cache`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          files: [...new Set(paths)].map(path => snapshotCacheUrl(config.origin, path)),
        }),
        signal: networkTimeout(8_000),
      },
    );
    if (response.ok) ok = (await response.json())?.success === true;
    else await response.body?.cancel();
  } catch {
    // No provider response, URL, headers or credentials leave this boundary.
  }
  invariant(
    ok,
    'HOSTED_REQUEST_FAILED',
    'Cloudflare did not confirm the public cache purge; retry the same page.',
  );
}
