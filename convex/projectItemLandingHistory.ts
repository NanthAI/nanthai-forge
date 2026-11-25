// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { maxIntentChain } from '../src/hosted-intent-chain';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { landingNoteWindow } from './projectIntentLandingNoteArchive';
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

// Creation-time ties can occur between adjacent writes. Keep cursor lookbehind
// proportional to a small batch, including when someone constructs a cursor.
const timePosition = z.object({ at: z.number().min(0), skip: z.number().int().min(1).max(512) });
const notePosition = z.union([timePosition, z.literal(false), z.null()]);
export const landingHistoryCursor = z.object({
  notes: z
    .array(notePosition)
    .max(maxIntentChain + 1)
    .nullable()
    .optional(),
});
type HistoryCursor = z.infer<typeof landingHistoryCursor>;
type TimePosition = z.infer<typeof timePosition>;
type NotePosition = z.infer<typeof notePosition>;
type NoteWindow = Awaited<ReturnType<typeof landingNoteWindow>>;

/** Archive routes retain Lane membership. Canonical receipts already hold the other Item Work fields. */
export async function itemLandingFromNote(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  note: NoteWindow[number],
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
  };
}

function windowFrom<T extends { _creationTime: number }>(rows: T[], from: TimePosition | undefined) {
  if (!from) return rows;
  let offset = 0;
  while (offset < from.skip && rows[offset]?._creationTime === from.at) offset++;
  return rows.slice(offset);
}

function windowAfter(
  rows: readonly { _creationTime: number }[],
  consumed: number,
  from: TimePosition | undefined,
): TimePosition {
  const at = rows[consumed - 1]!._creationTime;
  let skip = from?.at === at ? from.skip : 0;
  while (consumed > 0 && rows[--consumed]!._creationTime === at) skip++;
  return { at, skip };
}

/** Merge the recorded note windows without adding an index to the landing path.
 * A cursor consumes rows only from the windows it showed. Writes above the
 * boundary do not shift older rows, and tied creation times advance per Intent. */
async function notePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intents: readonly string[],
  from: NotePosition[] | undefined,
  limit: number,
) {
  const rawLimit = 2 * limit;
  const streams = await Promise.all(
    (from ?? intents.map(() => false as const)).map(async (position, index) => {
      const intentId = intents[index];
      if (!intentId || position === null) return { position, rows: [] as NoteWindow, consumed: 0 };
      const time = position || undefined;
      const rows = await landingNoteWindow(
        ctx,
        projectId,
        intentId,
        rawLimit + 1 + (time?.skip ?? 0),
        time?.at,
      );
      return { position, rows: windowFrom(rows, time), consumed: 0 };
    }),
  );
  const merged = streams.flatMap(stream => stream.rows.map(note => ({ note, stream })));
  merged.sort((a, b) => b.note._creationTime - a.note._creationTime);
  const receipts = new Map<string, NoteWindow[number]>();
  for (const { note, stream } of merged.slice(0, rawLimit)) {
    stream.consumed++;
    if (note.kind !== 'landed') continue;
    receipts.set(note.receiptId, note);
    if (receipts.size === limit) break;
  }
  const next = streams.map(({ position, rows, consumed }) =>
    consumed >= rows.length ? null : consumed ? windowAfter(rows, consumed, position || undefined) : position,
  );
  return {
    rows: await Promise.all([...receipts.values()].map(note => itemLandingFromNote(ctx, projectId, note))),
    next: next.some(value => value !== null) ? next : null,
  };
}

/** A single bounded page of landing notes. */
export async function itemLandingHistory(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intents: readonly string[],
  cursor: HistoryCursor,
  limit = ITEM_LANDINGS_PAGE,
) {
  const notes =
    cursor.notes === null ? undefined : await notePage(ctx, projectId, intents, cursor.notes, limit);
  const next = notes?.next ?? null;
  return {
    rows: notes?.rows ?? [],
    used: notes?.rows.length ?? 0,
    next: next === null ? null : { notes: next },
  };
}

export function cursorJson(cursor: string) {
  try {
    return JSON.parse(cursor) as unknown;
  } catch {
    return null;
  }
}
