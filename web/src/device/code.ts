// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

/** The name and access on the approval page once the server is asked again (the passkey or GitHub re-check that enables
 * Approve): what the person already edited stays, and only a first look takes the terminal's name and the server's
 * settings (friction 8710bfcf: the re-check put the terminal name back over an edit). */
export function recheckedDraft<S>(
  kept: { name: string; settings: S | undefined } | undefined,
  fresh: { name: string; settings: S | undefined },
): { name: string; settings: S | undefined } {
  return kept ? { name: kept.name, settings: kept.settings ?? fresh.settings } : fresh;
}

/** The draft the approval page holds after the server is asked: what was edited stays, a first look takes the terminal's. */
export function draftFor<S>(
  request: { name: string; device?: { settings?: S } },
  kept: { name: string; settings: S | undefined } | undefined,
) {
  return recheckedDraft(kept, { name: shownDeviceName(request.name), settings: request.device?.settings });
}

/** The passkey (or GitHub) re-check that enables Approve: the check first, then the server is asked again with the
 * person's draft, so an edited name is not put back to the terminal's (friction 8710bfcf). */
export async function passkeyRecheck<D>(
  confirm: () => Promise<void>,
  find: (kept: D) => Promise<D>,
  kept: D,
) {
  await confirm();
  return find(kept);
}

/** What Approve sends about the device: its draft name and access, only for a device Forge has not seen before. */
export function approvedDevice<S>(
  device: { known: boolean } | undefined,
  draft: { name: string; settings: S | undefined },
) {
  return device && !device.known ? { name: draft.name, settings: draft.settings } : {};
}

/** The access a device asks for, in plain words. */
export function scopeWords(scope: string): string {
  return scope === 'cli'
    ? 'Use Forge from the terminal as you: your projects and account'
    : 'Coordination only: report activity and messages for your projects';
}

/**
 * What a refused device-code call means, from the server's error code (never its wording): the code
 * expired or is unknown (`AUTH_EXPIRED`), or already has a decision (`AUTH_CODE_USED`). Any other
 * code, or none, is not a code problem; the caller shows the server's message and lets the person retry.
 */
export function codeProblem(code: string | undefined): 'expired' | 'used' | null {
  if (code === 'AUTH_EXPIRED') return 'expired';
  if (code === 'AUTH_CODE_USED') return 'used';
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
