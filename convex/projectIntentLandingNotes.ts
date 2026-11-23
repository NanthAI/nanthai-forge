// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue 3a733ee8: a landing posts its receipt to its Item, including landings the queue makes after
// the agent stopped. The landing writes one small row per Item-started Intent (it never reads an Item: the
// Item→Intent link is a one-way chain), and the Item's comment read walks that chain and returns the
// rows as `system` comments.
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { internalQuery } from './server';
import { ownedProject } from './projectAuthority';
import { recordHead } from './projectHostedRecords';
import {
  archiveNoteReference,
  landingNoteOrder,
  landingNoteWindow,
  pinArchivedNotes,
  type ArchivedNote,
  type LoadedLandingNote,
} from './projectIntentLandingNoteArchive';
import { invariant } from '../src/errors';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import {
  LANDING_NOTE_LANES,
  LANDING_NOTES_PER_ITEM,
  landingNoteComment,
  landingNoteExport,
  type LandingNote,
} from '../src/intent-landing-note';

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
  note: LandingNote,
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
  });
  return true;
}

/** Follow-up Intents have deterministic ids and can leave earlier Lanes open. */
export async function itemIntentChain(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  legacyHeads?: Id<'projectHostedRecordHeads'>[],
) {
  const intents: string[] = [];
  let current = itemId;
  let head = await recordHead(ctx, projectId, 'intent', current);
  let state: string | null = null;
  let selectingStatus = true;
  for (let hop = 0; head && hop <= maxIntentChain; hop++) {
    intents.push(current);
    if (head.planningItemId === undefined) legacyHeads?.push(head._id);
    if (selectingStatus) {
      state = head.status.startsWith('journal:') ? null : head.status;
      selectingStatus = intentFinished(head.status.replace(/^journal:/, ''));
    }
    if (hop === maxIntentChain) break;
    const next = successorIntentId(current);
    const following = await recordHead(ctx, projectId, 'intent', next);
    // A reopened earlier Intent becomes the active one again. A verified successor still
    // serves the same Item and remains part of its Work history.
    if (!following || (following.planningItemId ?? (selectingStatus ? itemId : null)) !== itemId) break;
    current = next;
    head = following;
  }
  return { intents, state };
}

/** System landing comments from the Item's own Intent chain and its linked chains, newest first. */
export type DiscussionNoteCursor = { at: number; intentId: string; skip: number };
export async function intentLandingComments(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  limit = LANDING_NOTES_PER_ITEM,
  links: readonly string[] = [itemId],
  chainRoots?: ReadonlySet<string>,
  before?: DiscussionNoteCursor,
) {
  const intents = new Set<string>();
  for (const link of links) {
    if (intents.has(link)) continue;
    for (const intentId of (await itemIntentChain(ctx, projectId, link)).intents) {
      // An explicitly linked successor owns its chain, even on a different comment page.
      if (intentId !== link && chainRoots?.has(intentId)) break;
      intents.add(intentId);
    }
  }
  const notes: Awaited<ReturnType<typeof landingNoteWindow>> = [];
  let includeThrough = before === undefined || !intents.has(before.intentId);
  for (const intentId of intents) {
    const sameIntent = before?.intentId === intentId;
    const alreadyShown = sameIntent ? (before?.skip ?? 0) : 0;
    includeThrough ||= sameIntent;
    const window = await landingNoteWindow(
      ctx,
      projectId,
      intentId,
      limit + 1 + alreadyShown,
      before?.at,
      includeThrough,
    );
    let offset = 0;
    while (offset < alreadyShown && window[offset]?._creationTime === before?.at) offset++;
    notes.push(...window.slice(offset));
    notes.sort((a, b) => b._creationTime - a._creationTime);
    if (notes.length > limit + 1) notes.length = limit + 1;
  }
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
      return [{ position: note._creationTime, value: landingNoteComment(itemId, stored.row) }];
    }
    return [{ position: note._creationTime, value: landingNoteComment(itemId, note) }];
  });
  const last = notes.length > limit ? selected.at(-1) : undefined;
  if (!last) return { comments, pending };
  const at = last._creationTime;
  const { intentId } = last;
  const previous = before?.at === at && before.intentId === intentId ? before.skip : 0;
  const skip =
    previous + selected.filter(note => note._creationTime === at && note.intentId === intentId).length;
  return { comments, pending, before: { at, intentId, skip } };
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
      .withIndex('by_project_and_intent', q => q.eq('projectId', projectId))
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
