// SPDX-License-Identifier: Apache-2.0
// Small pieces the behaviour parts share: the handle's dots, English ordinals ("2nd") for the drop line, the locale.
import type { ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
const ORDINAL = new Intl.PluralRules('en-US', { type: 'ordinal' });
const SUFFIX: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' };

export const ordinal = (n: number) => `${n}${SUFFIX[ORDINAL.select(n)] ?? 'th'}`;

export function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
      {[3, 8, 13].flatMap(y => [
        <circle key={`a${y}`} cx="2.5" cy={y} r="1.4" />,
        <circle key={`b${y}`} cx="7.5" cy={y} r="1.4" />,
      ])}
    </svg>
  );
}

/** The layer's own words (drag hints, "Dismiss") are English like the rest of Forge; the locale plugin in
 * web/vite.config.ts keeps only en-US, so the layer is told en-US whatever the browser's language. */
export function EnglishOnly({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en-US">{children}</I18nProvider>;
}
