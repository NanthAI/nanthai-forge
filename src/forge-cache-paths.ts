// SPDX-License-Identifier: Apache-2.0
/** Forge-owned metadata is never live source, even if an older client saved it.
 * Keep the legacy queue cache name here so migration needs no source deletion. */
export function forgeCachePath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts[0] === 'queue-ahead-objects' ||
    parts.some(
      part => part === '.forge' || part.endsWith('.forge-client') || part.endsWith('.forge-metrics.jsonl'),
    )
  );
}
