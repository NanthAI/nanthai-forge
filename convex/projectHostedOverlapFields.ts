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
    /** A Lane of the same Intent landed after this Lane went quiet (Issue 55024d40): the Lane keeps its
     * saved work and stays open, but leaves presence and advisory notices; blocking notices stay. It
     * names the head it was set on and ends at the Lane's next save or reopen. */
    superseded: v.optional(
      v.object({ by: v.string(), receiptId: v.string(), laneHead: v.string(), at: v.string() }),
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
    /** Set once another Lane was stacked on this one (Issue dc62b120): the Lane's own save, abandon and
     * landing events then look up its dependents in projectHostedStackDependents. Absent for every Lane
     * nobody stacked on, which therefore pay no extra read. */
    stacked: v.optional(v.literal(true)),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_open', ['projectId', 'open'])
    .index('by_project_and_open_and_activity', ['projectId', 'open', 'lastActivityAt']),
  /** Stacked Lanes (Issue dc62b120): one row per open Lane stacked on a parent Lane, written only by
   * stacked Lane records. It holds the parent head the child is pinned to and one mark per parent
   * event already announced, so each event reaches each dependent once. Deleted when the child
   * closes or unstacks. */
  projectHostedStackDependents: defineTable({
    projectId: v.id('hostedProjects'),
    parentLaneId: v.string(),
    laneId: v.string(),
    /** The parent head this child was last restacked onto (the Lane record's stack.head). */
    parentHead: v.string(),
    /** A "parent saved" notice is out and the child has not restacked since. */
    savedNoticed: v.optional(v.literal(true)),
    /** The parent was abandoned and the child was told; cleared when the parent is saved again. */
    ended: v.optional(v.literal('abandoned')),
    /** The parent's failed/cancelled landing was announced; cleared by a parent save or a restack. */
    landingNoticed: v.optional(v.literal(true)),
    /** The parent's newest saved head, set by each parent save after this child's pin (Issue f61e9339).
     * The child's next save restacks onto it automatically when that applies cleanly. */
    latestHead: v.optional(v.string()),
    /** A parent head whose automatic restack conflicted: later saves do not retry it; the next parent
     * save (a new latestHead) or the child's own restack re-arms it. */
    restackConflict: v.optional(v.string()),
  })
    .index('by_project_and_parent', ['projectId', 'parentLaneId'])
    .index('by_project_and_lane', ['projectId', 'laneId']),
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
  /** Slim peer row of each overlap row (Issue 5471e31c): scalars, saved-path fingerprints and cross-file
   * symbol facts without the per-path evidence, so a peer read loads full rows only for peers sharing a path
   * with the caller. A pure function of the overlap row (`overlapPeerOf`), written in the same
   * transaction as every write of that row. Rows of closed Lanes stay with their overlap row. */
  projectHostedOverlapPeers: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    agent: v.optional(v.string()),
    intent: v.string(),
    head: v.string(),
    baseHead: v.string(),
    resolutionLeft: v.optional(v.string()),
    recordVersion: v.number(),
    lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
    open: v.boolean(),
    supersededHead: v.optional(v.string()),
    complete: v.boolean(),
    lastActivityAt: v.optional(v.number()),
    presenceAt: v.optional(v.number()),
    /** 8 hex digits per saved path (`pathHash`): a miss is exact, a hit sends the read to the full row. */
    pathHashes: v.string(),
    exports: v.optional(v.array(v.string())),
    refs: v.optional(v.array(v.array(v.string()))),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_open', ['projectId', 'open'])
    .index('by_project_and_open_and_activity', ['projectId', 'open', 'lastActivityAt']),
  projectHostedOverlapMain: defineTable({
    projectId: v.id('hostedProjects'),
    sequence: v.number(),
    coverageAfter: v.number(),
    changes: v.string(),
    /** Recent landings for the drift nudge (see OverlapMain.landings); absent on rows written before it. */
    landings: v.optional(v.string()),
  }).index('by_project', ['projectId']),
};
