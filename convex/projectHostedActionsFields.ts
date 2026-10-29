// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

const pack = {
  stateRef: v.string(),
  objectKey: v.string(),
  sha256: v.string(),
  size: v.number(),
  fileCount: v.number(),
  createdAt: v.number(),
  expiresAt: v.number(),
};
export const hostedActionsTables = {
  projectSourcePacks: defineTable({
    projectId: v.id('hostedProjects'),
    latest: v.optional(v.object(pack)),
    other: v.optional(v.object({ ...pack, ready: v.boolean(), deleting: v.optional(v.boolean()) })),
  }).index('by_project', ['projectId']),
  projectHostedActionsExports: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    head: v.string(),
    value: v.string(),
  })
    .index('by_project_and_run', ['projectId', 'runId'])
    .index('by_project_and_head', ['projectId', 'head']),
};
