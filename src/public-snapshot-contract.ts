// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** Edge lookup and purge must name the same versioned entry, not the browser's query. */
export const snapshotCacheUrl = (origin: string, pathname: string) =>
  `${origin}${pathname}?forge-cache=public-pages-v1`;

/** The stored discovery envelope. A tombstone retains no member data and is never removed from its
 * serving key: the observed ETag and generation together fence stale publications. */
export type SnapshotFence =
  | { v: 1; state: 'hidden'; generation: number; at: number; tailRevision?: number }
  | { v: 1; state: 'public'; generation: number; asOf: number; contentHash: string };

export const snapshotRecord = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export const snapshotCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function snapshotFence(data: Record<string, unknown>): SnapshotFence | null {
  const { v, state, generation, asOf, contentHash, at, tailRevision } = data;
  if (v !== 1 || !snapshotCount(generation)) return null;
  if (state === 'hidden' && snapshotCount(at)) {
    const fields = Object.keys(data).length;
    if (fields === 4 && tailRevision === undefined) return { v, state, generation, at };
    if (fields === 5 && snapshotCount(tailRevision)) return { v, state, generation, at, tailRevision };
  }
  if (
    state === 'public' &&
    snapshotCount(asOf) &&
    typeof contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(contentHash)
  )
    return { v, state, generation, asOf, contentHash };
  return null;
}
