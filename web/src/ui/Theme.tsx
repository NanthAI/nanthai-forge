// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'forge-theme';
const listeners = new Set<() => void>();

export function readTheme(): ThemeChoice {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function apply(theme: ThemeChoice) {
  document.documentElement.dataset.theme =
    theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
}

function setTheme(theme: ThemeChoice) {
  localStorage.setItem(KEY, theme);
  apply(theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === KEY) {
      apply(readTheme());
      listener();
    }
  };
  addEventListener('storage', storage);
  return () => {
    listeners.delete(listener);
    removeEventListener('storage', storage);
  };
}

/** One shared theme for every control on the page; "system" follows the OS preference live. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'system' as ThemeChoice);
  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => apply('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [theme]);
  return [theme, setTheme] as const;
}
