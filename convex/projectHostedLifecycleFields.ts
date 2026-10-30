// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedLifecycleTables = {
  projectHostedLifecyclePlans: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    receiptId: v.string(),
    intentId: v.string(),
    authorityEpoch: v.number(),
    request: v.string(),
    at: v.string(),
    revision: v.number(),
    status: v.union(v.literal('pending'), v.literal('applied'), v.literal('stale'), v.literal('failed')),
    cursor: v.union(v.string(), v.null()),
    staged: v.number(),
    ready: v.boolean(),
    saveOperationId: v.union(v.string(), v.null()),
    savedExpected: v.union(v.string(), v.null()),
    landingSequence: v.optional(v.number()),
    materialized: v.boolean(),
    appliedThrough: v.number(),
    materializeCursor: v.union(v.string(), v.null()),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_actor_and_save', ['projectId', 'actor', 'saveOperationId']),
  projectHostedLifecycleGuards: defineTable({
    projectId: v.id('hostedProjects'),
    intentId: v.string(),
    revision: v.number(),
    planId: v.union(v.id('projectHostedLifecyclePlans'), v.null()),
  }).index('by_project_and_intent', ['projectId', 'intentId']),
  projectHostedLifecyclePointers: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    planId: v.id('projectHostedLifecyclePlans'),
    baseRecordId: v.id('projectHostedRecords'),
    recordId: v.id('projectHostedRecords'),
  }).index('by_project_and_lane', ['projectId', 'laneId']),
  projectHostedLifecycleEvents: defineTable({
    projectId: v.id('hostedProjects'),
    kind: v.union(v.literal('lane'), v.literal('intent')),
    key: v.string(),
    planId: v.id('projectHostedLifecyclePlans'),
    index: v.number(),
    value: v.string(),
  })
    .index('by_project_and_kind_and_key', ['projectId', 'kind', 'key'])
    .index('by_plan_and_index', ['planId', 'index']),
};
