// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedOverlapTables = {
  projectHostedOverlapLanes: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    /** The agent session's word-list slug (c29d0780); absent for a person. Shown as `handle/slug`. */
    agent: v.optional(v.string()),
    intent: v.string(),
    head: v.string(),
    baseHead: v.string(),
    resolutionLeft: v.optional(v.string()),
    baseReceiptId: v.string(),
    baseSequence: v.union(v.number(), v.null()),
    lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
    recordVersion: v.number(),
    open: v.boolean(),
    /** Set when an accepted receipt landed this exact saved head: Lane status reads it (no extra call). */
    landed: v.optional(
      v.object({ receiptId: v.string(), commit: v.string(), laneHead: v.string(), at: v.string() }),
    ),
    changes: v.string(),
    complete: v.boolean(),
    /** This Lane's presence row and the activity time it last wrote, so presence costs no read. */
    presenceRow: v.optional(v.object({ id: v.id('projectHostedPresence'), at: v.number() })),
    /** Last Lane record write (ms): save, start, sync or landing. A Lane idle past the project's
     * dormantAfterDays leaves overlap, presence and board reads through this index range. Absent on
     * rows written before the field existed; reads cover them through presenceRow.at until the Lane's
     * next write sets it. */
    lastActivityAt: v.optional(v.number()),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_open', ['projectId', 'open'])
    .index('by_project_and_open_and_activity', ['projectId', 'open', 'lastActivityAt']),
  // One row per Lane head whose agent response carried at least one overlap notice (metric 5.4 delivered).
  projectHostedOverlapDeliveries: defineTable({
    projectId: v.id('hostedProjects'),
    id: v.string(),
    actor: v.string(),
    laneId: v.string(),
    request: v.string(),
    value: v.string(),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project_and_lane', ['projectId', 'laneId']),
  /** Presence (Issue 9c8490a4): one slim row per open Lane, so a start reads ~0.5 KB per peer instead
   * of the full overlap row (measured 2026-11-05: 41 open rows, ~330 KB). Deleted when the Lane closes. */
  projectHostedPresence: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    /** The agent session's word-list slug (c29d0780); absent for a person. Shown as `handle/slug`. */
    agent: v.optional(v.string()),
    goal: v.string(),
    paths: v.array(v.string()),
    pathCount: v.number(),
    /** Last Lane record time (ms). */
    at: v.number(),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_at', ['projectId', 'at'])
    .index('by_project_and_intent_and_at', ['projectId', 'intentId', 'at']),
  projectHostedOverlapMain: defineTable({
    projectId: v.id('hostedProjects'),
    sequence: v.number(),
    coverageAfter: v.number(),
    changes: v.string(),
  }).index('by_project', ['projectId']),
};
