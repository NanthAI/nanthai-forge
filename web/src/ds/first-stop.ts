// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The first stop's edge beats --beats times, then holds (base.css). It beats again only when what waits on the reader
// changes, when the page is shown and when the reader comes back to the tab: event-driven, no timer, no request.
import { useEffect, useRef } from 'react';

/** Attach to the one element with data-weight="act" on a screen. `waiting` names what waits (ids joined, a count). */
export function useFirstStop<T extends HTMLElement>(waiting: string | number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    // Dropping the attribute for one frame restarts the CSS animation without reading layout.
    const beat = () => {
      cancelAnimationFrame(frame);
      el.removeAttribute('data-first');
      frame = requestAnimationFrame(
        () => (frame = requestAnimationFrame(() => el.setAttribute('data-first', ''))),
      );
    };
    const shown = () => {
      if (document.visibilityState === 'visible') beat();
    };
    shown();
    document.addEventListener('visibilitychange', shown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [waiting]);
  return ref;
}
