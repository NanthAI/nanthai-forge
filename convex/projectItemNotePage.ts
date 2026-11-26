// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getPage } from 'convex-helpers/server/pagination';
import { z } from 'zod';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import schema from './schema';

export const itemNoteKey = z.tuple([z.string().min(1).max(40), z.number().nonnegative(), z.string()]);
type NoteKey = z.infer<typeof itemNoteKey>;
type Note = Doc<'projectIntentLandingNotes'>;

export const noteKey = (note: Note): NoteKey => [note.at, note._creationTime, note._id];

/** The landing time is primary. Creation time and row ID make tied landings stable on every page. */
export function newestItemNote(a: Note, b: Note) {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  if (a._creationTime !== b._creationTime) return b._creationTime - a._creationTime;
  return a._id > b._id ? -1 : a._id < b._id ? 1 : 0;
}

export async function itemNotePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  scope: { itemId: string } | { intentId: string },
  after: NoteKey | undefined,
  limit: number,
) {
  const prefix = [projectId, 'itemId' in scope ? scope.itemId : scope.intentId];
  return getPage(ctx, {
    schema,
    table: 'projectIntentLandingNotes',
    index: 'itemId' in scope ? 'by_project_and_item_and_at' : 'by_project_and_intent_and_at',
    order: 'desc',
    startIndexKey: after ? [...prefix, ...after] : prefix,
    startInclusive: after === undefined,
    endIndexKey: prefix,
    endInclusive: true,
    targetMaxRows: limit,
    absoluteMaxRows: limit,
  });
}
