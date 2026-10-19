// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';

/** Storage may be unavailable in private/embedded contexts; the controls still work. */
export function useLanePreference<T extends string>(key: string, values: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return fallback;
    const query = new URLSearchParams(window.location.search).get(key.split('.').at(-1)!);
    if (values.includes(query as T)) return query as T;
    try {
      const stored = window.localStorage.getItem(key);
      return values.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* Session state remains usable. */
      }
    },
  ] as const;
}
