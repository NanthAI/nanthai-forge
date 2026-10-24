// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { groupDecisions, type DecisionItem } from '../cockpit/attention';
const key = 'forge.now.notNow';
const listeners = new Set<() => void>();
let memory = '[]';
function read() {
  try {
    return sessionStorage.getItem(key) ?? memory;
  } catch {
    return memory;
  }
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
  let hidden: Set<string>;
  try {
    hidden = new Set(JSON.parse(raw) as string[]);
  } catch {
    hidden = new Set();
  }
  return {
    shown: groupDecisions(items.filter(item => !hidden.has(item.id))),
    notNow: (id: string) => () => {
      let current: string[];
      try {
        current = JSON.parse(read()) as string[];
      } catch {
        current = [];
      }
      memory = JSON.stringify([...new Set([...current, id])]);
      try {
        sessionStorage.setItem(key, memory);
      } catch {
        /* Keep session memory in private mode. */
      }
      listeners.forEach(listener => listener());
    },
  };
}
