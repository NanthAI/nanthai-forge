// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Landing notes are selected, paged and shown by one key: the landing time `at`. A row's creation time says
// when a note was written, which for a converted landing (Item c0af6cfa) is long after it landed.
import { z } from 'zod';

/** A cursor position inside one Intent's notes: the last landing time shown and how many notes at exactly
 * that time were consumed (ties are rare; the window reads past them). */
export const notePosition = z.object({
  at: z.string().min(1).max(40),
  skip: z.number().int().min(1).max(512),
});
export type NotePosition = z.infer<typeof notePosition>;

/** The landing time of a note row. Notes archived before the field existed carry none until the one-off job
 * sets it, and sort oldest. */
export const noteAt = (row: { at?: string }) => row.at ?? '';

/** Newest first: a later landing sorts before an earlier one. */
export const newerNote = (a: { at?: string }, b: { at?: string }) =>
  noteAt(a) < noteAt(b) ? 1 : noteAt(a) > noteAt(b) ? -1 : 0;

export function skipNoteTies<T extends { at?: string }>(rows: T[], from: NotePosition | undefined) {
  if (!from) return rows;
  let offset = 0;
  while (offset < from.skip && rows[offset] && noteAt(rows[offset]!) === from.at) offset++;
  return rows.slice(offset);
}

/** The position after `consumed` leading rows of a window that already skipped `from`. */
export function notePositionAfter(
  rows: readonly { at?: string }[],
  consumed: number,
  from: NotePosition | undefined,
): NotePosition {
  const at = noteAt(rows[consumed - 1]!);
  let skip = from?.at === at ? from.skip : 0;
  while (consumed > 0 && noteAt(rows[--consumed]!) === at) skip++;
  return { at, skip };
}
