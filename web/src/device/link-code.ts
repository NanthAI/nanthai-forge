// SPDX-License-Identifier: Apache-2.0
// A device code that arrives in a link (`?code=`) leaves the address as soon as an approval page loads, so it is not
// readable in the address bar, kept in browser history or carried into a sign-in return address. The page keeps it in
// this tab's session storage for the 10 minutes a code lives, so it survives a sign-in round trip. Shared by /device
// and the rebuilt /device.
import { codeComplete, formatCode } from './code';

const KEY = 'forge.device-code';
/** The code the person typed from their terminal, kept in this tab across the GitHub check's redirect (df06081d)
 * under the same 10-minute rule as a link code; an answer or restart forgets it with the link code. */
const TYPED = 'forge.device-typed';
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
    sessionStorage.removeItem(TYPED);
  } catch {
    // nothing kept
  }
}

/** Before the GitHub check leaves the page: keep the request and what was typed, and return where to come back. */
export function githubReturn(
  input: { code: string; typed: string; fromLink: boolean; requestId: string },
  now = Date.now(),
): string {
  const typed = input.fromLink || input.requestId ? input.typed : input.code;
  // A code typed into the first field comes back like a link code, already typed, so Approve stays unlocked.
  if (!input.fromLink && !input.requestId && codeComplete(input.code)) keep(input.code, now);
  if (codeComplete(typed)) {
    try {
      // Bound to the request it answers: a different request or link code never inherits it.
      sessionStorage.setItem(
        TYPED,
        JSON.stringify({ code: formatCode(typed), at: now, for: input.requestId || formatCode(input.code) }),
      );
    } catch {
      // Private mode: the person types the code again after the check.
    }
  }
  const back = new URL('/device', location.origin);
  if (input.requestId) back.searchParams.set('request', input.requestId);
  return back.href;
}

/** The code typed before the GitHub check for this request (`requestId`, else the link code); '' when none,
 * for another request, or older than a code lives. A value that does not apply is forgotten. */
export function takeTypedCode(current: { requestId: string; code: string }, now = Date.now()): string {
  let code = '';
  try {
    const kept = JSON.parse(sessionStorage.getItem(TYPED) ?? 'null') as {
      code?: unknown;
      at?: unknown;
      for?: unknown;
    } | null;
    if (
      kept &&
      typeof kept.code === 'string' &&
      typeof kept.at === 'number' &&
      now >= kept.at &&
      now - kept.at < LIFE_MS &&
      kept.for === (current.requestId || formatCode(current.code)) &&
      codeComplete(kept.code)
    )
      code = formatCode(kept.code);
    else if (kept) sessionStorage.removeItem(TYPED);
  } catch {
    // unreadable: nothing kept
  }
  return code;
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
  // Only the stale link code goes: a typed code kept for the GitHub check's return has its own clock.
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
  return '';
}
