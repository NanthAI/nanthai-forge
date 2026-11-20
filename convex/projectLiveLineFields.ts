// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const liveLineStage = v.union(
  v.literal('editing'),
  v.literal('saved'),
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
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_held', ['projectId', 'held'])
    .index('by_source', ['sourceId']),
};
