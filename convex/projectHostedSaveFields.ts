// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedSaveTables = {
  projectHostedSaves: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    jobId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_job', ['projectId', 'jobId']),
  projectHostedSavePages: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    index: v.number(),
    digest: v.string(),
  }).index('by_project_and_actor_and_operation_and_index', ['projectId', 'actor', 'operationId', 'index']),
  projectHostedStates: defineTable({
    projectId: v.id('hostedProjects'),
    head: v.string(),
    size: v.number(),
    input: v.string(),
    jobId: v.string(),
    output: v.string(),
  }).index('by_project_and_head', ['projectId', 'head']),
};
