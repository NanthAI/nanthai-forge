// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Browser lifecycle rule 1 for Convex Auth (docs/development.md, "Convex Auth core beside Clerk"): a token refresh that
// falls due while the tab is hidden or dormant waits, and every refresh asked for meanwhile is answered by exactly one
// refresh when the tab wakes. Without it a hidden tab refreshes once an hour for as long as it stays open.
// App code around the Convex client's auth hook; the library is not patched. No timer: it waits on events only.
import type { LiveReads } from '../live-reads';

type FetchToken = (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
type Page = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** Wraps `fetchToken` so it runs only while the tab is awake; calls made while asleep share one call on wake. */
export function holdWhileAsleep(fetchToken: FetchToken, reads: LiveReads, page: Page = document): FetchToken {
  let waiting: { force: boolean; promise: Promise<string | null | undefined> } | null = null;
  const asleep = () => page.visibilityState === 'hidden' || reads.dormant;
  return args => {
    if (!asleep() && !waiting) return fetchToken(args);
    if (waiting) {
      waiting.force ||= args.forceRefreshToken;
      return waiting.promise;
    }
    const held: { force: boolean; promise: Promise<string | null | undefined> } = {
      force: args.forceRefreshToken,
      promise: new Promise((resolve, reject) => {
        const check = () => {
          if (asleep()) return;
          stopReads();
          page.removeEventListener('visibilitychange', check);
          waiting = null;
          fetchToken({ forceRefreshToken: held.force }).then(resolve, reject);
        };
        const stopReads = reads.subscribe(check);
        page.addEventListener('visibilitychange', check);
      }),
    };
    waiting = held;
    return held.promise;
  };
}

type AuthClient = { setAuth(fetchToken: FetchToken, ...rest: unknown[]): unknown };

/** The Convex client the auth provider uses: identical, except `setAuth` gets the held token fetch. */
export function withRefreshHold<T extends object>(client: T, reads: LiveReads, page: Page = document): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'setAuth' && typeof value === 'function')
        return (fetchToken: FetchToken, ...rest: unknown[]) =>
          (value as AuthClient['setAuth']).call(target, holdWhileAsleep(fetchToken, reads, page), ...rest);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
