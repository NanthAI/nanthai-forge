// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Who published a landing (Issue 3a733ee8): the queue (a scheduled step, no signed-in caller), an
 * agent's explicit accept, or a person's. The stored `review` field records person acceptance. */
const landingPublisher = v.union(v.literal('queue'), v.literal('agent'), v.literal('person'));
export const landingNoteBy = v.object({
  by: landingPublisher,
  review: v.union(v.literal('person'), v.literal('none')),
});

const identity = {
  projectId: v.id('hostedProjects'),
  intentId: v.string(),
  receiptId: v.string(),
  kind: v.union(v.literal('landed'), v.literal('reverted')),
  laneIds: v.array(v.string()),
  viaLaneId: v.optional(v.string()),
  revertOf: v.optional(v.string()),
};

/** One row per Intent, receipt and kind. A verified capsule replaces the hot body with a reference
 * in the same row. Lane attribution remains transactional for Item Work and Initiative rebuilds. */
export const intentLandingNoteTables = {
  projectIntentLandingNotes: defineTable(
    v.union(
      v.object({
        ...identity,
        at: v.string(),
        commit: v.string(),
        sequence: v.number(),
        /** Submitter account, mapped to a handle per viewer on read. */
        actor: v.string(),
        agentRun: v.optional(v.string()),
        agentClient: v.optional(v.string()),
        landedBy: v.optional(landingNoteBy),
      }),
      v.object({
        ...identity,
        capsule: v.string(),
        landedBy: v.optional(v.object({ by: landingPublisher })),
      }),
    ),
  )
    .index('by_project_and_receipt_and_intent_and_kind', ['projectId', 'receiptId', 'intentId', 'kind'])
    // index-order: caller: convex/projectIntentLandingNoteArchive.ts#landingNoteWindow; order: the newest notes of one Intent by creation time.
    .index('by_project_and_intent', ['projectId', 'intentId']),
};
