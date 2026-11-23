// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One row of the Code place's history (convex/projectCode.ts#history): a landing on main, from its stored receipt
// alone. The web screen and its tests share this shape; nothing here reads storage.
import { readAuthorship } from './work-actor-types.js';
import type { HostedAcceptance } from './hosted-acceptance.js';

/** Receipts per page and the read budget of one page (a receipt is about 2 to 6 KB). */
export const CODE_HISTORY_PAGE = 25;
export const CODE_HISTORY_READ_BYTES = 256 * 1024;
/** The title is the message's first line; the rest is the receipt's "why", cut at this many characters. */
export const CODE_HISTORY_TITLE_CHARS = 200;
export const CODE_HISTORY_WHY_CHARS = 600;

export type CodeHistoryRow = {
  receiptId: string;
  sequence: number;
  /** When main moved (ISO). */
  at: string;
  /** The message's first line; null when the landing carried no message. */
  title: string | null;
  why: string | null;
  /** The submitting account; the public identity rule turns it into a handle or removes it. */
  actor?: string;
  agent: boolean;
  /** The agent run, shown as `handle/run`. Absent on older receipts and on person landings. */
  agentRun: string | null;
  /** The agent's app as it declared it; not verified. */
  agentClient: string | null;
  /** The exact States before and after: browse the code at either. */
  head: string;
  base: string;
  automatic: boolean;
  /** The check that accepted it: null when it landed without one. */
  check: { runId: string; testsSkipped: boolean } | null;
  firstCheck: 'admission-run' | 'recheck' | 'scoped-intersection' | null;
  /** Landed with others in one checked batch. */
  batch: boolean;
  docsMerged: boolean;
};

export type CodeFileHistoryPage = {
  landings: CodeHistoryRow[];
  /** Receipts examined on this page whose exact changed paths were not retained. */
  missing: number;
  /** Every receipt examined on this page. Older cached responses omitted the count. */
  scanned?: number;
  nextBefore: number | null;
};

/** The handle a landing shows: `@person`, `person/agent` for an agent run, or "an agent" when people are hidden.
 * The web (code-words.ts) and the CLI file log share it. */
export function landedBy(row: Pick<CodeHistoryRow, 'actor' | 'agent' | 'agentRun'>): string | null {
  if (!row.actor) return row.agent ? 'an agent' : null;
  return row.agent && row.agentRun ? `${row.actor}/${row.agentRun}` : `@${row.actor}`;
}

export const CODE_RECEIPT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function codeHistoryRow(receipt: HostedAcceptance, sequence: number, visitor = false): CodeHistoryRow {
  const builder = readAuthorship(receipt);
  const message = (receipt.message ?? '').trim();
  const [first = '', ...rest] = message.split('\n');
  const why = rest.join('\n').trim();
  return {
    receiptId: receipt.id,
    sequence,
    at: receipt.at,
    title: first.trim() ? first.trim().slice(0, CODE_HISTORY_TITLE_CHARS) : null,
    why: why ? why.slice(0, CODE_HISTORY_WHY_CHARS) : null,
    ...(visitor ? {} : { actor: builder.actor ?? receipt.actor.id }),
    agent: builder.kind === 'agent',
    agentRun: receipt.agentRun ?? null,
    agentClient: receipt.agentClient ?? null,
    head: receipt.candidate.head,
    base: receipt.previous.head,
    automatic: receipt.automatic,
    check: receipt.check
      ? // Tests the change's paths did not reach were skipped, never left pending (9e71abcc).
        { runId: receipt.check.runId, testsSkipped: Boolean(receipt.check.skipped) }
      : null,
    firstCheck: receipt.firstCheck?.landedOn ?? null,
    batch: Boolean(receipt.batchId),
    docsMerged: Boolean(receipt.docsResolution),
  };
}
