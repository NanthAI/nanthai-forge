// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedDecisionTables = {
  projectHostedDecisions: defineTable({
    projectId: v.id('hostedProjects'),
    id: v.string(),
    request: v.string(),
    value: v.string(),
    target: v.string(),
    supersedes: v.optional(v.string()),
    actor: v.string(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project_and_target', ['projectId', 'target']),
  projectHostedDecisionMaintainers: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    enabled: v.boolean(),
    operationId: v.string(),
    request: v.string(),
  })
    .index('by_project_and_actor', ['projectId', 'actor'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
};
