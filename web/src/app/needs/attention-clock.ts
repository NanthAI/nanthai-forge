// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useState } from 'react';
import { needsAttention, type NeedsRead } from './count';

/** Repaint only at the next known threshold. No clock reads from Convex. */
export function useAttentionClock(read: NeedsRead | undefined, drawnAt: number) {
  const [wokeAt, setWokeAt] = useState(0);
  const now = Math.max(drawnAt, wokeAt);
  const next = read ? needsAttention(read, now).nextAt : Infinity;
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const delay = Math.min(Math.max(0, next - Date.now()), 2_147_483_647);
    const timer = setTimeout(() => setWokeAt(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}
