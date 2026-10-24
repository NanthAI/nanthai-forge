// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedFinishTables = {
  projectHostedFinishes: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    composeOperationId: v.union(v.string(), v.null()),
    parentSubmissionId: v.union(v.string(), v.null()),
    waiting: v.boolean(),
    wake: v.union(
      v.object({ id: v.string(), taskId: v.id('_scheduled_functions'), at: v.number() }),
      v.null(),
    ),
    value: v.string(),
  })
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_compose', ['projectId', 'composeOperationId'])
    .index('by_project_and_parent_and_waiting', ['projectId', 'parentSubmissionId', 'waiting']),
};
