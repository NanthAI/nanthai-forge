// SPDX-License-Identifier: Apache-2.0
// Navigation for the rebuilt app: the address is the state. A link is a real <a href> (new tab, copy link and middle
// click work); a plain click moves in place with pushState, so browser Back and Forward walk the same entries.
// No timers and no reads: a change of place re-renders from the address alone.
import { useSyncExternalStore, type MouseEvent } from 'react';
import { oldAddress } from './old-address';
import { isAppPath, parseAppPath, type AppRoute } from './paths';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
let current = '';
let route: AppRoute = parseAppPath('/');
/** Moves in place only to an app address; an old one (old-address.ts) loads as a page, which resolves it. */
const inApp = (url: URL) =>
  url.origin === location.origin && isAppPath(url.pathname) && !oldAddress(url.pathname, url.search);

function snapshot() {
  const href = location.pathname + location.search;
  if (href !== current) {
    current = href;
    route = parseAppPath(location.pathname);
  }
  return route;
}

function subscribe(listener: () => void) {
  if (!listeners.size) addEventListener('popstate', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) removeEventListener('popstate', notify);
  };
}

export function useRoute(): AppRoute {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Query parameters of the current address (sign-in's next, a device code). */
export function useSearch(): URLSearchParams {
  useRoute();
  return new URLSearchParams(location.search);
}

/** Move to an address of the rebuilt app in place; any other address loads as a page. */
export function navigate(href: string, { replace = false } = {}) {
  const url = new URL(href, location.href);
  if (!inApp(url)) {
    location.assign(url.href);
    return;
  }
  const next = url.pathname + url.search + url.hash;
  if (next === location.pathname + location.search + location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', next);
  notify();
  // A new place starts at its top, and focus goes to its main landmark so a screen reader announces the new page.
  if (!replace) {
    scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }
}

/** The click handler for an <a href> inside the rebuilt app: modified clicks keep the browser's own behaviour. */
export function followLink(event: MouseEvent<HTMLAnchorElement | SVGAElement>) {
  const anchor = event.currentTarget;
  const target = typeof anchor.target === 'string' ? anchor.target : anchor.getAttribute('target');
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (target && target !== '_self')
  )
    return;
  const href = typeof anchor.href === 'string' ? anchor.href : anchor.href.baseVal;
  if (!href) return;
  const url = new URL(href, location.href);
  if (!inApp(url)) return;
  event.preventDefault();
  navigate(url.href);
}

/** Keyboard navigation of the frames (keys.tsx): the key a press means, or null when it belongs to a field or another
 * shortcut. Keys never fire while the reader types in a field or holds a modifier other than the palette's. */
export function keyAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  target: EventTarget | null,
  hasProject: boolean,
  hasRail = false,
): 'palette' | 'keys' | 'rail' | { place: number } | null {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') return 'palette';
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const element = target as HTMLElement | null;
  if (
    element?.closest?.(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]',
    )
  )
    return null;
  if (event.key === '?') return 'keys';
  if (hasRail && !event.shiftKey && event.key === '[') return 'rail';
  if (hasProject && !event.shiftKey && /^[1-6]$/.test(event.key)) return { place: Number(event.key) - 1 };
  return null;
}
