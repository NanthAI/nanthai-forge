// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedOverlapTables = {
  projectHostedOverlapLanes: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    intent: v.string(),
    head: v.string(),
    baseHead: v.string(),
    baseReceiptId: v.string(),
    baseSequence: v.union(v.number(), v.null()),
    lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
    recordVersion: v.number(),
    open: v.boolean(),
    changes: v.string(),
    complete: v.boolean(),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_open', ['projectId', 'open']),
  projectHostedOverlapMain: defineTable({
    projectId: v.id('hostedProjects'),
    sequence: v.number(),
    coverageAfter: v.number(),
    changes: v.string(),
  }).index('by_project', ['projectId']),
};
