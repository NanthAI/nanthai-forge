// SPDX-License-Identifier: Apache-2.0
// Issue 3a733ee8: every landing posts its receipt to its Item, including landings the queue makes after
// the agent stopped. The landing writes one small row per landed Intent (it never reads an Item: the
// Item→Intent link is a one-way chain), and the Item's comment read walks that chain and returns the
// rows as `system` comments.
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { recordHead } from './projectHostedRecords';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import {
  LANDING_NOTE_LANES,
  LANDING_NOTES_PER_ITEM,
  landingNoteComment,
  type LandingNote,
} from '../src/intent-landing-note';

/** Who published a landing and whether a person reviewed it, from the publishing call path (no read):
 * the queue's driver and the internal publish are `queue`; the explicit accept is the accepting agent or
 * person; an owner approval is a person. `reviewed`: a person accepted it, or an owner approval carried. */
export function landingPublisher(
  by: 'queue' | 'agent' | 'person',
  reviewed: boolean,
): NonNullable<LandingNote['landedBy']> {
  return { by, review: reviewed ? 'person' : 'none' };
}

/** Writes the note once per (Intent, receipt, kind): one indexed probe, then one insert. A replayed or
 * resumed completion tick, a guard replay or a repeated revert notice finds the row and writes nothing.
 * Never throws for a well-formed note: a note must not fail the landing's completion. */
export async function postIntentLandingNote(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  note: LandingNote,
) {
  const old = await ctx.db
    .query('projectIntentLandingNotes')
    .withIndex('by_project_and_intent_and_receipt_and_kind', q =>
      q
        .eq('projectId', projectId)
        .eq('intentId', note.intentId)
        .eq('receiptId', note.receiptId)
        .eq('kind', note.kind),
    )
    .unique();
  if (old) return false;
  await ctx.db.insert('projectIntentLandingNotes', {
    projectId,
    intentId: note.intentId,
    receiptId: note.receiptId,
    kind: note.kind,
    at: note.at,
    laneIds: note.laneIds.slice(0, LANDING_NOTE_LANES),
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

/** The Item's system landing comments, newest first: the Intents of its chain (the Issue's own id, then
 * `successorIntentId` hops while the Intent is finished, the same walk as `intentStates`), and per Intent
 * one index range of its newest notes. At most LANDING_NOTES_PER_ITEM in all. An Item with no started
 * Intent costs one head read. */
export async function intentLandingComments(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  limit = LANDING_NOTES_PER_ITEM,
) {
  const intents: string[] = [];
  let at = itemId;
  let head = await recordHead(ctx, projectId, 'intent', at);
  for (let hop = 0; head && hop <= maxIntentChain; hop++) {
    intents.push(at);
    if (!intentFinished(head.status.replace(/^journal:/, ''))) break;
    at = successorIntentId(at);
    head = await recordHead(ctx, projectId, 'intent', at);
  }
  const notes = [];
  for (const intentId of intents) {
    const rows = await ctx.db
      .query('projectIntentLandingNotes')
      .withIndex('by_project_and_intent', q => q.eq('projectId', projectId).eq('intentId', intentId))
      .order('desc')
      .take(limit);
    notes.push(...rows);
  }
  return notes
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, limit)
    .map(row => ({ position: row._creationTime, value: landingNoteComment(itemId, row) }));
}
