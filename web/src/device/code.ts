// SPDX-License-Identifier: Apache-2.0
/** Device codes are ten letters and digits shown as XXXXX-XXXXX; the server ignores case, spaces and dashes. */
export const CODE_LENGTH = 10;
const ALLOWED = /[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;

/** Paste-tolerant formatting: keeps only code characters, upper-cases, and groups as XXXXX-XXXXX. */
export function formatCode(value: string): string {
  const chars = (value.toUpperCase().match(ALLOWED) ?? []).join('').slice(0, CODE_LENGTH);
  return chars.length > 5 ? `${chars.slice(0, 5)}-${chars.slice(5)}` : chars;
}

export function codeComplete(value: string): boolean {
  return formatCode(value).replace('-', '').length === CODE_LENGTH;
}

/** "in 8 min", "in 40 s", or "now" once passed. */
export function expiresIn(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds} s`;
  return `in ${Math.round(seconds / 60)} min`;
}

/** The access a device asks for, in plain words. */
export function scopeWords(scope: string): string {
  return scope === 'cli'
    ? 'Use Forge from the terminal as you: your projects and account'
    : 'Coordination only: report activity and messages for your projects';
}

/** Server messages that mean the code can no longer be used, and what to do about it. */
export function codeProblem(message: string): 'expired' | 'used' | null {
  if (/expired|unavailable/i.test(message)) return 'expired';
  if (/already has a decision/i.test(message)) return 'used';
  return null;
}

/** Longest terminal-supplied name the approval page shows. */
export const SHOWN_NAME_MAX = 40;
/**
 * The terminal chooses its own name, so the page treats it as untrusted text: control, invisible
 * and direction-changing characters are dropped, spaces collapse, and the length is capped.
 */
export function shownDeviceName(name: string): string {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean];
  return chars.length > SHOWN_NAME_MAX
    ? `${chars.slice(0, SHOWN_NAME_MAX - 1).join('')}…`
    : clean || 'unnamed';
}
