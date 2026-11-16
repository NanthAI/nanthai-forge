// SPDX-License-Identifier: Apache-2.0
// A device code that arrives in a link (`?code=`) leaves the address as soon as an approval page loads, so it is not
// readable in the address bar, kept in browser history or carried into a sign-in return address. The page keeps it in
// this tab's session storage for the 10 minutes a code lives, so it survives a sign-in round trip. Shared by /device
// and the rebuilt /-/device.
import { codeComplete, formatCode } from './code';

const KEY = 'forge.device-code';
/** A code lasts 10 minutes (convex/deviceActions.ts); a kept one is never older. */
const LIFE_MS = 600_000;

/**
 * Removes `code` from the address (other parameters stay) and returns it formatted; with no code in the address,
 * returns the complete code kept earlier in this tab, or ''.
 */
export function takeLinkCode(now = Date.now()): string {
  const url = new URL(location.href);
  const raw = url.searchParams.get('code');
  if (raw === null) return keptCode(now);
  url.searchParams.delete('code');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  const code = formatCode(raw);
  if (codeComplete(code)) keep(code, now);
  else forgetLinkCode();
  return code;
}

/** The code is answered, refused or replaced: a reload must not offer it again. */
export function forgetLinkCode() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
}

function keep(code: string, at: number) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ code, at }));
  } catch {
    // Private mode: the person types the code after signing in instead.
  }
}

function keptCode(now: number): string {
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { code?: unknown; at?: unknown } | null;
    if (
      kept &&
      typeof kept.code === 'string' &&
      typeof kept.at === 'number' &&
      now >= kept.at &&
      now - kept.at < LIFE_MS &&
      codeComplete(kept.code)
    )
      return formatCode(kept.code);
  } catch {
    // unreadable: nothing kept
  }
  forgetLinkCode();
  return '';
}
