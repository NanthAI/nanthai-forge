// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';

export const RECENT_LANDING_COUNT = 5;
export const FYI_LANDINGS = 12;
const TITLE_BYTES = 100;
const utf8 = new TextEncoder();

export type RecentLandingTitle = [receiptId: string, title: string | null];

export function fyiOneLine(text: string | undefined) {
  return (
    text
      ?.split('\n')
      .find(line => line.trim())
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280) ?? null
  );
}

type Receipt = {
  submissionId: string;
  at: string;
  actor?: { id: string; kind: string };
  check?: unknown;
  checked?: false;
  firstCheck?: { landedOn: string; reason?: string };
};

export function fyiLandingFact(
  receipt: Receipt,
  message: string | undefined,
  intentId: string | null,
): NonNullable<Doc<'projectHostedAcceptanceSnapshots'>['fyi']> {
  const redone = receipt.firstCheck?.landedOn === 'recheck';
  return {
    at: Date.parse(receipt.at),
    // Clipping a title can leave half of a surrogate pair. Convex stores valid Unicode strings.
    title: fyiOneLine(message)?.replace(/\p{Surrogate}/gu, '\uFFFD') ?? null,
    actor: receipt.actor?.id ?? null,
    ...(receipt.actor?.kind === 'agent' && { agent: true }),
    ...(receipt.check !== null && receipt.check !== undefined && { checked: true }),
    ...(receipt.checked === false && { hidden: true }),
    intentId,
    ...(redone && { recheckSubmissionId: receipt.submissionId }),
    ...(redone && receipt.firstCheck?.reason !== undefined && { redoneWhy: receipt.firstCheck.reason }),
  };
}

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
