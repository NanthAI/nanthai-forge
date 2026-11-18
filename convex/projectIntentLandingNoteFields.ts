// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Who published a landing (Issue 3a733ee8): the queue (a scheduled step, no signed-in caller), an
 * agent's explicit accept, or a person's. `review`: a person accepted it or an owner grant carried. */
export const landingNoteBy = v.object({
  by: v.union(v.literal('queue'), v.literal('agent'), v.literal('person')),
  review: v.union(v.literal('person'), v.literal('none')),
});

/** System landing notes (Issue 3a733ee8): one small row per landed or reverted Intent per receipt,
 * written by the landing's completion tick (or the revert notice), read as `system` comments on the
 * Item whose Intent chain holds it. Derived from receipts: not source, not exported or backed up. */
export const intentLandingNoteTables = {
  projectIntentLandingNotes: defineTable({
    projectId: v.id('hostedProjects'),
    intentId: v.string(),
    /** The landing receipt (a revert: the compensating receipt). */
    receiptId: v.string(),
    kind: v.union(v.literal('landed'), v.literal('reverted')),
    /** Receipt time (ISO). */
    at: v.string(),
    /** The Lanes of this Intent the receipt carried, at most LANDING_NOTE_LANES. */
    laneIds: v.array(v.string()),
    commit: v.string(),
    sequence: v.number(),
    /** Submitter account (mapped to a handle per viewer on read, never stored as a name). */
    actor: v.string(),
    agentRun: v.optional(v.string()),
    agentClient: v.optional(v.string()),
    landedBy: v.optional(landingNoteBy),
    /** The Lane this Intent's work landed through (a resolution or successor Lane of another Intent). */
    viaLaneId: v.optional(v.string()),
    /** reverted: the receipt whose change was reverted. */
    revertOf: v.optional(v.string()),
  })
    .index('by_project_and_intent_and_receipt_and_kind', ['projectId', 'intentId', 'receiptId', 'kind'])
    // index-order: caller: convex/projectIntentLandingNotes.ts#intentLandingComments; order: the newest notes of one Intent by creation time.
    .index('by_project_and_intent', ['projectId', 'intentId']),
};
