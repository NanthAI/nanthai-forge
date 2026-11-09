// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore } from 'react';
import { groupDecisions, type DecisionItem } from '../cockpit/attention';
const key = 'forge.now.notNow';
/** Dismissals one tab can hold; the oldest go first so the set never grows without bound. */
export const NOT_NOW_LIMIT = 200;
const listeners = new Set<() => void>();
let memory = '[]';

/** "Not now" hides one decision about one thing: the id plus the head, run or notice it was raised for. */
export const dismissalKey = (item: Pick<DecisionItem, 'id' | 'version'>) =>
  item.version === undefined ? item.id : `${item.id}@${item.version}`;
const baseId = (stored: string) => {
  const at = stored.indexOf('@');
  return at < 0 ? stored : stored.slice(0, at);
};

/**
 * Drop dismissals made for an older version of a decision that is still listed under a newer one, and
 * keep at most NOT_NOW_LIMIT keys. A dismissal for a decision that is not listed (it may sit in another
 * project, or its reads may still be loading) is kept.
 */
export function pruneDismissed(stored: readonly string[], items: readonly DecisionItem[]): string[] {
  const current = new Map(items.map(item => [item.id, dismissalKey(item)]));
  const kept = stored.filter(entry => {
    const live = current.get(baseId(entry));
    return live === undefined || live === entry;
  });
  return kept.slice(-NOT_NOW_LIMIT);
}
function parse(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
function read() {
  try {
    return sessionStorage.getItem(key) ?? memory;
  } catch {
    return memory;
  }
}
function write(entries: readonly string[]) {
  memory = JSON.stringify(entries);
  try {
    sessionStorage.setItem(key, memory);
  } catch {
    /* Keep session memory in private mode. */
  }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    removeEventListener('storage', listener);
  };
}
/** The panel and shell count exactly the same visible decisions, including Not now. */
export function useVisibleDecisions(items: readonly DecisionItem[]) {
  const raw = useSyncExternalStore(subscribe, read, () => '[]');
  const stored = parse(raw);
  const hidden = new Set(stored);
  // Stale keys are pruned once per change, not per render; writing only when something went.
  useEffect(() => {
    const kept = pruneDismissed(parse(read()), items);
    if (kept.length !== parse(read()).length) write(kept);
  }, [raw, items]);
  return {
    shown: groupDecisions(items.filter(item => !hidden.has(dismissalKey(item)))),
    notNow: (item: DecisionItem) => () => {
      write(pruneDismissed([...new Set([...parse(read()), dismissalKey(item)])], items));
    },
  };
}
