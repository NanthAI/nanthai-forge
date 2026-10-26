// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedSyncTables = {
  projectHostedSyncs: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    jobId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_job', ['projectId', 'jobId']),
};
