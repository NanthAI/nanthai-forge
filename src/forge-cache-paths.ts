// SPDX-License-Identifier: Apache-2.0
/** Transient filesystem-event probe folders start with this name (scripts/filesystem-event-health.mjs);
 * one a killed older client left in `.forge` is Forge-owned: clean ignores it, disposal removes it. */
export const EVENT_PROBE_PREFIX = '.forge-event-probe-';
export const hostedLaneMarkerName = 'hosted-lane.json';
export const laneScratchName = 'scratch';
export const laneScratchPath = `.forge/${laneScratchName}`;

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
