// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  /** The landing time, the key every reader selects, pages and shows a note by (Item c0af6cfa). */
  at: v.string(),
  laneIds: v.array(v.string()),
  viaLaneId: v.optional(v.string()),
  revertOf: v.optional(v.string()),
  /** Set on a `landed` note when a revert of it is accepted: the revert's receipt (Item c0af6cfa). */
  revertedBy: v.optional(v.string()),
};

/** One row per Intent, receipt and kind. A verified capsule replaces the hot body with a reference
 * in the same row. Lane attribution remains transactional for Item Work and Initiative rebuilds. */
export const intentLandingNoteTables = {
  projectIntentLandingNotes: defineTable(
    v.union(
      v.object({
        ...identity,
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
    // index-order: caller: convex/projectIntentLandingNoteArchive.ts#landingNoteWindow; order: the newest notes of one Intent by landing time (`at`), the key every reader selects, pages and shows by.
    .index('by_project_and_intent_and_at', ['projectId', 'intentId', 'at']),
};
