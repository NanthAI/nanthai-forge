// SPDX-License-Identifier: Apache-2.0
// What the rebuilt app keeps between a sign-in redirect and the page it returns to. Session storage only: it never
// leaves this tab, holds no token (the auth library keeps those) and is cleared once used.
import { ConvexError } from 'convex/values';
import { oldAddress } from './old-address';
import { ROOT, isAppPath } from './paths';

const KEY = 'forge.signin';
export type Pending = { next: string; method: 'github' | 'passkey'; handle?: string };

/** Where to go after signing in: a same-origin address of the rebuilt app, else the account's projects. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return `${ROOT}/account`;
  const url = new URL(value, 'https://forge.invalid');
  // An old id-only link (`?project=<id>`) is resolved after sign-in, so it comes back unchanged (old-address.ts).
  // `/.//host/…` normalizes to a pathname the router would read as another origin.
  return url.origin === 'https://forge.invalid' &&
    !url.pathname.startsWith('//') &&
    (isAppPath(url.pathname) || oldAddress(url.pathname, url.search)?.kind === 'look') &&
    !url.pathname.toLowerCase().startsWith(`${ROOT}/signin`)
    ? url.pathname + url.search
    : `${ROOT}/account`;
}

export function remember(pending: Pending) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Private mode: the sign-in still works; the person lands on their projects.
  }
}

export function recall(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Pending | null;
    return value && typeof value.next === 'string' ? { ...value, next: safeNext(value.next) } : null;
  } catch {
    return null;
  }
}

export function forget() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

/** The structured code of a refused Forge call (never its wording), or undefined. */
export function errorCode(error: unknown): string | undefined {
  const data = error instanceof ConvexError ? (error.data as unknown) : undefined;
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : undefined;
}
