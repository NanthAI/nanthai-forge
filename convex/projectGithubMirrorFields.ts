// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const githubMirrorTables = {
  projectGithubMirrors: defineTable({
    projectId: v.id('hostedProjects'),
    repository: v.string(),
    activeId: v.union(v.id('projectGithubMirrorJobs'), v.null()),
    // githubSyncCommitSchema payload, shared with the native Mac pusher.
    mapping: v.union(v.string(), v.null()),
    mirroredAt: v.optional(v.number()),
  }).index('by_project', ['projectId']),
  projectGithubMirrorJobs: defineTable({
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    sequence: v.number(),
    repository: v.string(),
    authorityEpoch: v.number(),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('retrying'),
      v.literal('failed'),
      v.literal('done'),
    ),
    state: v.string(),
    seed: v.optional(v.string()),
    step: v.number(),
    cursor: v.union(v.string(), v.null()),
    scheduledId: v.optional(v.id('_scheduled_functions')),
    error: v.optional(v.string()),
    detail: v.optional(v.string()),
    failures: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    httpStatus: v.optional(v.number()),
    apiOperation: v.optional(v.string()),
    requestBytes: v.optional(v.number()),
    mapping: v.optional(v.string()),
  })
    .index('by_project_and_state', ['projectId', 'state'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_status_and_sequence', ['projectId', 'status', 'sequence']),
};
