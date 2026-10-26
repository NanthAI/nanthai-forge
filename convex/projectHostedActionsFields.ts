// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const hostedActionsTables = {
  projectHostedActionsExports: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    head: v.string(),
    value: v.string(),
  })
    .index('by_project_and_run', ['projectId', 'runId'])
    .index('by_project_and_head', ['projectId', 'head']),
};
