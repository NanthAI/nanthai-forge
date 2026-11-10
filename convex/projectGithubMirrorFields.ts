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
    /** Lowercased repository name, so a signed push webhook finds its mirror (two-way sync). */
    repositoryKey: v.optional(v.string()),
    /** The last inbound landing's outcome (convex/projectGithubInbound.ts inboundOutcomeSchema). */
    inbound: v.optional(v.string()),
    /** The pull request job whose final forge/verify status could not be posted to GitHub (set on
     * failure only, cleared by a successful re-post or a newer head of that pull request). */
    verifyFailedId: v.optional(v.id('projectGithubMirrorJobs')),
  })
    .index('by_project', ['projectId'])
    .index('by_repository_key', ['repositoryKey']),
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
    /** Only lagging CI checks add a wake on completion; healthy mirrors do no extra reads. */
    ciWaiters: v.optional(v.literal(true)),
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
    /** Two-way sync: this job brings GitHub main in as a Forge landing (src/github-inbound-job.ts
     * JSON) instead of publishing an accepted State. Sequence 0 runs it before queued publishes. */
    inbound: v.optional(v.string()),
    /** A pull request job's PR number, so a newer head finds and supersedes older ones. */
    pullKey: v.optional(v.string()),
    /** The compose operation, then the check run, a pull request job waits on (one indexed
     * read when either settles, never a poll). */
    waitKey: v.optional(v.string()),
  })
    .index('by_project_and_state', ['projectId', 'state'])
    .index('by_project_and_pull', ['projectId', 'pullKey'])
    .index('by_project_and_wait', ['projectId', 'waitKey'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_status_and_sequence', ['projectId', 'status', 'sequence']),
};
