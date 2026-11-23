// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Lifecycle rule 2 for Convex Auth (docs/development.md, "Convex Auth core beside Clerk"): passkey autofill runs only
// while the sign-in tab is visible and active. The library starts autofill when its hook mounts and renews the
// challenge about every eight minutes while mounted, so the sign-in screen mounts that hook inside WhileAwake: a hidden
// or idle tab holds no challenge and makes no calls, and the return mounts it once.
import { useSyncExternalStore, type ReactNode } from 'react';
import { liveReads, useReadsAsleep, type LiveReads } from '../live-reads';

const visibility = {
  subscribe(listener: () => void) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  get: () => document.visibilityState !== 'hidden',
};

/** Visible and not idle (live reads awake). */
export function useAwake(reads: LiveReads = liveReads) {
  const shown = useSyncExternalStore(visibility.subscribe, visibility.get, () => true);
  const asleep = useReadsAsleep(reads);
  return shown && !asleep;
}

/** Renders its children only while the tab is awake, or while `keep` holds them (a press being carried out). */
export function WhileAwake({
  keep = false,
  reads,
  children,
}: {
  keep?: boolean;
  reads?: LiveReads;
  children: ReactNode;
}) {
  return useAwake(reads) || keep ? children : null;
}
