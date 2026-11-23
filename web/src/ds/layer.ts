// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// How the behaviour layer arrives: on the first press or focus of a part that needs it, or once when the browser is
// idle after a screen that uses it has painted. One fetch, cached by the browser; no timer, no polling, no request to
// the backend. The first-paint chunks never contain it (scripts/ds-build-guard.mjs fails the build if they do).
import { useEffect, useSyncExternalStore } from 'react';

export type Layer = typeof import('./behaviour');

let layer: Layer | null = null;
let pending: Promise<Layer> | null = null;
let idleAsked = false;
const listeners = new Set<() => void>();

export function loadLayer(): Promise<Layer> {
  pending ??= import('./behaviour').then(
    loaded => {
      layer = loaded;
      listeners.forEach(listener => listener());
      return loaded;
    },
    error => {
      pending = null; // a later press tries again
      throw error;
    },
  );
  return pending;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The layer once loaded, else null; asks for it once when the browser is idle and the tab is shown. */
export function useLayer(): Layer | null {
  const current = useSyncExternalStore(
    subscribe,
    () => layer,
    () => null,
  );
  useEffect(() => {
    if (!current) prefetchLayerWhenIdle();
  }, [current]);
  return current;
}

/** One idle fetch per page load, only while the tab is visible. */
export function prefetchLayerWhenIdle() {
  if (idleAsked || layer || typeof window === 'undefined') return;
  idleAsked = true;
  const go = () => void loadLayer().catch(() => undefined);
  const whenIdle = () =>
    'requestIdleCallback' in window
      ? window.requestIdleCallback(go, { timeout: 4000 })
      : requestAnimationFrame(go);
  if (document.visibilityState === 'visible') whenIdle();
  else {
    const shown = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', shown);
      whenIdle();
    };
    document.addEventListener('visibilitychange', shown);
  }
}
