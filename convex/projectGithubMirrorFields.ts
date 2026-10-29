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
  }).index('by_project', ['projectId']),
  projectGithubMirrorJobs: defineTable({
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    sequence: v.number(),
    repository: v.string(),
    authorityEpoch: v.number(),
    status: v.union(v.literal('queued'), v.literal('running'), v.literal('failed'), v.literal('done')),
    state: v.string(),
    seed: v.optional(v.string()),
    step: v.number(),
    cursor: v.union(v.id('_storage'), v.null()),
    scheduledId: v.optional(v.id('_scheduled_functions')),
    error: v.optional(v.string()),
    detail: v.optional(v.string()),
    mapping: v.optional(v.string()),
  })
    .index('by_project_and_state', ['projectId', 'state'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_status_and_sequence', ['projectId', 'status', 'sequence']),
};
