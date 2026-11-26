// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { itemNoteKey, itemNotePage, noteKey } from './projectItemNotePage';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { invariant } from '../src/errors';

export const ITEM_LANDINGS_PAGE = 10;

export type ItemLanding = {
  receiptId: string;
  commit: string;
  at: string;
  sequence?: number;
  landedBy?: string;
  revertedBy?: string;
};

export const landingHistoryCursor = z.object({ notes: itemNoteKey });
type HistoryCursor = z.infer<typeof landingHistoryCursor>;

/** Archive routes retain Lane membership and the revert link. Canonical receipts already hold the other Item Work fields. */
export async function itemLandingFromNote(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  note: Doc<'projectIntentLandingNotes'>,
): Promise<ItemLanding> {
  let evidence: Pick<ItemLanding, 'commit' | 'at' | 'sequence'>;
  if ('commit' in note) {
    evidence = { commit: note.commit, at: note.at, sequence: note.sequence };
  } else {
    const row = await acceptanceRow(ctx, { projectId, receiptId: note.receiptId });
    invariant(row, 'SOURCE_UNAVAILABLE', 'The archived note’s landing receipt is unavailable.');
    const receipt = JSON.parse(row.value) as HostedAcceptance;
    evidence = { commit: receipt.candidate.head, at: receipt.at, sequence: receipt.snapshot.revision };
  }
  return {
    receiptId: note.receiptId,
    ...evidence,
    ...(note.landedBy ? { landedBy: note.landedBy.by } : {}),
    ...(note.revertedBy ? { revertedBy: note.revertedBy } : {}),
  };
}

/** Each bounded window advances over reverts and repeated receipts as well as displayed landings. */
export async function itemLandingHistory(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  cursor?: HistoryCursor,
  limit = ITEM_LANDINGS_PAGE,
) {
  const { page, hasMore } = await itemNotePage(ctx, projectId, { itemId }, cursor?.notes, 2 * limit);
  const receipts = new Map<string, Doc<'projectIntentLandingNotes'>>();
  let consumed = 0;
  for (const note of page) {
    if (note.kind === 'landed' && !receipts.has(note.receiptId)) {
      if (receipts.size === limit) break;
      receipts.set(note.receiptId, note);
    }
    consumed++;
  }
  const last = page[consumed - 1];
  const next = last && (consumed < page.length || hasMore) ? { notes: noteKey(last) } : null;
  const rows = await Promise.all(
    [...receipts.values()].map(note => itemLandingFromNote(ctx, projectId, note)),
  );
  return { rows, used: rows.length, next };
}

export function cursorJson(cursor: string) {
  try {
    return JSON.parse(cursor) as unknown;
  } catch {
    return null;
  }
}
