// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore } from 'react';
import { Glyph } from './Glyph';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'forge-theme';
const order: readonly ThemeChoice[] = ['system', 'light', 'dark'];
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

const names: Record<ThemeChoice, string> = {
  system: 'System theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

/** One button that cycles system → light → dark and always says which theme is active. */
export function ThemeToggle() {
  const [theme, choose] = useTheme();
  const next = order[(order.indexOf(theme) + 1) % order.length]!;
  return (
    <button
      type="button"
      className="fx-icon-btn"
      title={`${names[theme]} · switch to ${names[next].toLowerCase()}`}
      aria-label={`${names[theme]}. Switch to ${names[next].toLowerCase()}`}
      onClick={() => choose(next)}
    >
      <Glyph name={theme === 'system' ? 'system' : theme === 'light' ? 'sun' : 'moon'} size={15} />
    </button>
  );
}

/** Explicit theme choices in the account menu. */
export function ThemePicker() {
  const [theme, choose] = useTheme();
  return (
    <div className="fx-theme-picker">
      <span>Theme</span>
      <div className="fx-seg" role="group" aria-label="Theme">
        {order.map(choice => (
          <button
            key={choice}
            type="button"
            role="menuitemradio"
            aria-checked={theme === choice}
            title={names[choice]}
            aria-label={names[choice]}
            onClick={() => choose(choice)}
          >
            <Glyph name={choice === 'system' ? 'system' : choice === 'light' ? 'sun' : 'moon'} size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}
