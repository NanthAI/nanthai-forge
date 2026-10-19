// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { getFunctionName } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';

/** A hidden tab keeps live reads this long, so a quick tab switch does not re-read every page. */
export const HIDDEN_GRACE_MS = 30_000;
/** A visible tab with no input or focus for this long stops live reads until the next input. */
export const IDLE_MS = 5 * 60_000;

type Watch = {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): unknown;
  journal?(): unknown;
};
type Entry = { key: string; real: Watch; listener: () => void; unsubscribe: (() => void) | null };

/**
 * Live Convex reads that can sleep. While dormant every server subscription is dropped, mounted
 * components keep their last values, and on wake each mounted read subscribes once for fresh data.
 * One-shot queries, mutations and actions are never held.
 */
export function createLiveReads() {
  let dormant = false;
  const entries = new Set<Entry>();
  const last = new Map<string, { refs: number; value?: unknown }>();
  const listeners = new Set<() => void>();
  const setDormant = (next: boolean) => {
    if (dormant === next) return;
    dormant = next;
    for (const entry of entries)
      if (next) {
        entry.unsubscribe?.();
        entry.unsubscribe = null;
      } else entry.unsubscribe ??= entry.real.onUpdate(entry.listener);
    for (const listener of [...listeners]) listener();
  };
  const wrap = (key: string, real: Watch): Watch => ({
    onUpdate(listener) {
      const entry: Entry = { key, real, listener, unsubscribe: dormant ? null : real.onUpdate(listener) };
      entries.add(entry);
      const held = last.get(key) ?? { refs: 0 };
      held.refs++;
      last.set(key, held);
      return () => {
        if (!entries.delete(entry)) return;
        entry.unsubscribe?.();
        if (--held.refs === 0) last.delete(key);
      };
    },
    localQueryResult() {
      const held = last.get(key);
      if (dormant) return held?.value;
      const value = real.localQueryResult();
      if (value === undefined) return held?.value;
      if (held) held.value = value;
      return value;
    },
    ...(real.journal ? { journal: () => real.journal!() } : {}),
  });
  return {
    get dormant() {
      return dormant;
    },
    sleep: () => setDormant(true),
    wake: () => setDormant(false),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Distinct live reads this controller currently holds on the server. */
    get subscriptions() {
      const keys = new Set<string>();
      for (const entry of entries) if (entry.unsubscribe) keys.add(entry.key);
      return keys.size;
    },
    /** The client for React hooks; every other client method goes to the real client unchanged. */
    client<T extends object>(real: T): T {
      type Reference = Parameters<typeof getFunctionName>[0];
      const watcher = (kind: 'q' | 'p', method: string) => {
        const watch = (real as Record<string, unknown>)[method];
        return typeof watch !== 'function'
          ? undefined
          : (query: Reference, ...rest: unknown[]) =>
              wrap(
                `${kind}:${getFunctionName(query)}:${JSON.stringify(convexToJson((rest[0] ?? {}) as Value))}` +
                  (kind === 'p' ? `:${JSON.stringify(rest[1] ?? null)}` : ''),
                (watch as (...args: unknown[]) => Watch).call(real, query, ...rest),
              );
      };
      // watchPaginatedQuery backs Convex's experimental paginated hook; it is not in the public type.
      const watchQuery = watcher('q', 'watchQuery'),
        watchPaginatedQuery = watcher('p', 'watchPaginatedQuery');
      return new Proxy(real, {
        get(target, property) {
          if (property === 'watchQuery') return watchQuery;
          if (property === 'watchPaginatedQuery') return watchPaginatedQuery;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
    /**
     * Sleep after `HIDDEN_GRACE_MS` hidden or `IDLE_MS` without input; wake on the next input,
     * focus or visibility. One pending timeout at a time; nothing polls.
     */
    watchActivity(target: Window = window, page: Document = document) {
      let lastInput = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (delay: number) => {
        clearTimeout(timer);
        timer = setTimeout(check, delay);
      };
      const check = () => {
        timer = undefined;
        if (page.visibilityState === 'hidden') return setDormant(true);
        const quiet = Date.now() - lastInput;
        if (quiet >= IDLE_MS) setDormant(true);
        else arm(IDLE_MS - quiet);
      };
      const input = () => {
        lastInput = Date.now();
        if (page.visibilityState === 'hidden') return;
        setDormant(false);
        if (timer === undefined) arm(IDLE_MS);
      };
      const visibility = () => {
        if (page.visibilityState === 'hidden') arm(HIDDEN_GRACE_MS);
        else input();
      };
      const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
      for (const name of events) target.addEventListener(name, input, { capture: true, passive: true });
      page.addEventListener('visibilitychange', visibility);
      visibility();
      return () => {
        clearTimeout(timer);
        for (const name of events) target.removeEventListener(name, input, { capture: true });
        page.removeEventListener('visibilitychange', visibility);
      };
    },
  };
}
export type LiveReads = ReturnType<typeof createLiveReads>;

/** The app's live reads; `Hosted` wraps its Convex client with it. */
export const liveReads = createLiveReads();

/** True while live reads are asleep (hidden or idle tab). */
export function useReadsAsleep(reads: LiveReads = liveReads) {
  return useSyncExternalStore(
    reads.subscribe,
    () => reads.dormant,
    () => false,
  );
}
