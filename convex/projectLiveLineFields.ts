// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const liveLineStage = v.union(
  v.literal('editing'),
  v.literal('saved'),
  /** Submitted, waiting for its check (Item 85f456c1): set from the submission's phase on the patch it already writes. */
  v.literal('queued'),
  v.literal('checking'),
  v.literal('ready'),
);
export const liveLineTables = {
  // No actor, session, activity clock, check progress or source paths belong here.
  projectLiveLineLanes: defineTable({
    projectId: v.id('hostedProjects'),
    sourceId: v.id('projectHostedOverlapLanes'),
    laneId: v.string(),
    stage: liveLineStage,
    held: v.boolean(),
    overlap: v.boolean(),
    changedAt: v.number(),
    /** Lanes checked together share this short key while they are checked (Item 85f456c1). */
    check: v.optional(v.string()),
    /** Held only because main is failing: no person is asked (Item 85f456c1). */
    mainRed: v.optional(v.literal(true)),
    /** Held on the Lane's own next step (a failed check, a conflict, a wait for its parent or a green main): no person
     * has an action, so the project list and the top bar's F count it as agent work (Issue f5c4d136). Absent on a hold
     * that waits on a person (an approval or review) and on rows from before it existed. */
    fix: v.optional(v.literal(true)),
    /** A submission of this Lane ended without landing since the Lane last landed: its next landing is not a first
     * try (Item 32e8de50). Rides the patch that end already makes; never read by the line feed. */
    retried: v.optional(v.literal(true)),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_held', ['projectId', 'held'])
    .index('by_source', ['sourceId']),
};
