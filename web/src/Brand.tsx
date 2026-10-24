// SPDX-License-Identifier: Apache-2.0
import { useTheme, type ThemeChoice } from './ui/Theme';
import { ForgeMark } from './shell/brand';

export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="NanthAi Forge home">
      <ForgeMark />
      <span className="brand-name">
        <span className="brand-parent">NanthAi</span>
        <span className="brand-suffix">Forge</span>
      </span>
    </a>
  );
}
export function ThemeControl() {
  const [theme, setTheme] = useTheme();
  return (
    <label className="theme-control">
      <span className="sr-only">Colour theme</span>
      <select aria-label="Colour theme" value={theme} onChange={e => setTheme(e.target.value as ThemeChoice)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
