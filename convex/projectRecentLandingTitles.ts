// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

export const RECENT_LANDING_COUNT = 5;
const TITLE_BYTES = 100;
const utf8 = new TextEncoder();

export type RecentLandingTitle = [receiptId: string, title: string | null];

/** Keep a first line that fits the byte budget without cutting a code point. */
export function recentLandingTitle(message: string | undefined): string | null {
  const line = message
    ?.trim()
    .split(/[\r\n\u2028\u2029]/, 1)[0]
    ?.replace(/[\u0000-\u001f]/g, '')
    ?.trim();
  if (!line) return null;
  let bytes = 0;
  let title = '';
  for (const char of line) {
    bytes += utf8.encode(char).length;
    if (bytes > TITLE_BYTES) break;
    title += char;
  }
  return title.trimEnd();
}
