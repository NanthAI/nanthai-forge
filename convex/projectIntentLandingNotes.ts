// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue 3a733ee8: a landing posts its receipt to its Item, including landings the queue makes after
// the agent stopped. The landing writes one small row per Item-started Intent using the Item binding
// already held on the Intent head. The Item's comment read returns the rows as `system` comments.
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { internalQuery } from './server';
import { ownedProject } from './projectAuthority';
import { storeItem } from './projectWorkStoreReads';
import { recordHead } from './projectHostedRecords';
import { itemLandingNotesPurging } from './projectItemPurgeFence';
import {
  archiveNoteReference,
  landingNoteOrder,
  pinArchivedNotes,
  type ArchivedNote,
  type LoadedLandingNote,
} from './projectIntentLandingNoteArchive';
import { itemNotePage, newestItemNote, noteKey, type itemNoteKey } from './projectItemNotePage';
import type { z } from 'zod';
import { invariant } from '../src/errors';
import {
  LANDING_NOTE_LANES,
  LANDING_NOTES_PER_ITEM,
  landingNoteComment,
  landingNoteExport,
  type LandingNote,
} from '../src/intent-landing-note';

/** The Item tombstone survives the bounded receipt window, including for new landings after a purge. */
export async function itemLandingNoteTombstone(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
) {
  return Boolean((await storeItem(ctx, project._id, itemId))?.purged);
}

/** Who published a landing and whether a person accepted it, from the publishing call path (no read):
 * the queue's driver and the internal publish are `queue`; the explicit accept is the accepting agent or
 * person; an owner approval is a person. The stored `review` field records acceptance. */
export function landingPublisher(
  by: 'queue' | 'agent' | 'person',
  personAccepted: boolean,
): NonNullable<LandingNote['landedBy']> {
  return { by, review: personAccepted ? 'person' : 'none' };
}

/** Upsert one note per (Intent, receipt, kind). Later pages and completion ticks merge their
 * Lanes into the same row. A replay that adds no facts writes nothing. */
export async function postIntentLandingNote(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  note: LandingNote & { itemId: string },
) {
  const old = await ctx.db
    .query('projectIntentLandingNotes')
    .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
      q
        .eq('projectId', projectId)
        .eq('receiptId', note.receiptId)
        .eq('intentId', note.intentId)
        .eq('kind', note.kind),
    )
    .unique();
  if (old) {
    if ('capsule' in old) return false;
    const laneIds = [...new Set([...old.laneIds, ...note.laneIds])].slice(0, LANDING_NOTE_LANES);
    const viaLaneId = old.viaLaneId ?? note.viaLaneId;
    if (laneIds.length === old.laneIds.length && viaLaneId === old.viaLaneId) return false;
    await ctx.db.patch(old._id, { laneIds, ...(viaLaneId ? { viaLaneId } : {}) });
    return true;
  }
  await ctx.db.insert('projectIntentLandingNotes', {
    projectId,
    intentId: note.intentId,
    itemId: note.itemId,
    receiptId: note.receiptId,
    kind: note.kind,
    at: note.at,
    laneIds: [...new Set(note.laneIds)].slice(0, LANDING_NOTE_LANES),
    commit: note.commit,
    sequence: note.sequence,
    actor: note.actor,
    ...(note.agentRun ? { agentRun: note.agentRun } : {}),
    ...(note.agentClient ? { agentClient: note.agentClient } : {}),
    ...(note.landedBy ? { landedBy: note.landedBy } : {}),
    ...(note.viaLaneId ? { viaLaneId: note.viaLaneId } : {}),
    ...(note.revertOf ? { revertOf: note.revertOf } : {}),
    ...(note.checked === false ? { checked: false as const } : {}),
  });
  return true;
}

/** Link the original note to its revert and return the Item that can receive the revert note.
 * A recovered landing can supply the Item when the legacy Intent has no binding. */
export async function markNoteReverted(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  intentId: string,
  boundItem: string | undefined,
  revertOf: string,
  revertedBy: string,
) {
  const original = await ctx.db
    .query('projectIntentLandingNotes')
    .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
      q.eq('projectId', project._id).eq('receiptId', revertOf).eq('intentId', intentId).eq('kind', 'landed'),
    )
    .unique();
  const itemId = boundItem ?? original?.itemId;
  if (
    !itemId ||
    itemLandingNotesPurging(project, itemId) ||
    (await itemLandingNoteTombstone(ctx, project, itemId))
  )
    return undefined;
  if (original && !original.revertedBy) await ctx.db.patch(original._id, { revertedBy });
  return itemId;
}

/** A note sits at its landing time, the key it was selected and paged by (never its creation time: a
 * converted landing was written long after it landed, Item c0af6cfa). */
function commentAt<T extends { at: string }>(note: { _creationTime: number }, value: T) {
  return { position: Date.parse(value.at) || note._creationTime, value };
}

/** System landing comments from the Item and its explicit links. Each link contributes one range. */
export async function intentLandingComments(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  limit = LANDING_NOTES_PER_ITEM,
  links: readonly string[] = [itemId],
  before?: z.infer<typeof itemNoteKey>,
) {
  const pages = await Promise.all(
    links.map(async id => {
      const exact = id === itemId ? null : await recordHead(ctx, projectId, 'intent', id);
      // An explicit Intent link outside the Item keeps that Intent's own notes.
      const scope = exact && exact.planningItemId !== id ? { intentId: id } : { itemId: id };
      return itemNotePage(ctx, projectId, scope, before, limit);
    }),
  );
  const notes = [...new Map(pages.flatMap(page => page.page).map(note => [note._id, note])).values()].sort(
    newestItemNote,
  );
  const selected = notes.slice(0, limit);
  const loaded = (ctx as QueryCtx & { landingNotesLoaded?: LoadedLandingNote[] }).landingNotesLoaded;
  const byKey = new Map(loaded?.map(entry => [entry.key, entry]));
  if (byKey.size) {
    const references = selected.flatMap(note => {
      if (!('capsule' in note)) return [];
      const ref = archiveNoteReference(note);
      return byKey.has(ref.key) ? [ref] : [];
    });
    for (const pin of await pinArchivedNotes(ctx, projectId, references))
      invariant(
        byKey.get(pin.key)?.sha256 === pin.pointer.sha256,
        'WORK_STALE',
        'Landing note history changed during the read.',
      );
  }
  const pending: ArchivedNote[] = [];
  const comments = selected.flatMap(note => {
    if ('capsule' in note) {
      const reference = archiveNoteReference(note);
      const stored = byKey.get(reference.key);
      if (!stored || stored.submissionId !== note.capsule) {
        pending.push(reference);
        return [];
      }
      return [commentAt(note, landingNoteComment(itemId, stored.row))];
    }
    return [commentAt(note, landingNoteComment(itemId, note))];
  });
  const last = selected.at(-1);
  const more = notes.length > limit || pages.some(page => page.hasMore);
  return { comments, pending, ...(last && more ? { before: noteKey(last) } : {}) };
}

/** The owner-only planning export scans the existing project index in pages. */
const exportArgs = {
  projectId: v.id('hostedProjects'),
  owner: v.string(),
  cursor: v.union(v.string(), v.null()),
};
export const exportPage = internalQuery({
  args: exportArgs,
  returns: v.object({
    notes: v.string(),
    continueCursor: v.string(),
    isDone: v.boolean(),
    archived: v.optional(v.string()),
  }),
  handler: async (ctx, { projectId, owner, cursor }) => {
    await ownedProject(ctx, projectId, owner);
    const page = await ctx.db
      .query('projectIntentLandingNotes')
      .withIndex('by_project_and_intent_and_at', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: 200 });
    const archived = page.page.flatMap(row => ('capsule' in row ? [archiveNoteReference(row)] : []));
    const notes = page.page.flatMap(row =>
      'capsule' in row ? [] : [[landingNoteOrder(row), landingNoteExport(row)]],
    );
    return {
      notes: JSON.stringify(notes),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      ...(archived.length
        ? { archived: JSON.stringify(await pinArchivedNotes(ctx, projectId, archived)) }
        : {}),
    };
  },
});
