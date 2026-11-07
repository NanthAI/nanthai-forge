// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';

/** The server's soonest window end (ms since epoch); absent when no count has a window to expire. */
export type Expiring = { nextExpiryAt?: number };

/** True once the counts' soonest window has ended: they are unknown from then on, until a write re-runs the query. */
export const countsExpired = (counts: Expiring, now: number) =>
  counts.nextExpiryAt !== undefined && counts.nextExpiryAt <= now;

/** One timer to the expiry; returns its cancel. Never queries, polls or subscribes. */
export function scheduleCountsExpiry(
  counts: Expiring | undefined,
  now: number,
  expire: () => void,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): () => void {
  if (!counts || counts.nextExpiryAt === undefined) return () => {};
  const timer = timers.setTimeout(expire, Math.max(0, Math.min(counts.nextExpiryAt - now, 2 ** 31 - 1)));
  return () => timers.clearTimeout(timer);
}

/** The counts while their windows are open, `null` (unknown) after `nextExpiryAt`, `undefined` while loading. */
export function useExpiringCounts<T extends Expiring>(counts: T | undefined): T | null | undefined {
  const [, setTick] = useState(0);
  useEffect(() => scheduleCountsExpiry(counts, Date.now(), () => setTick(tick => tick + 1)), [counts]);
  if (!counts) return counts;
  return countsExpired(counts, Date.now()) ? null : counts;
}
