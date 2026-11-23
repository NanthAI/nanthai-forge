// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
    /** Last actual ref move by this publisher, independent of inbound mapping updates. */
    pushedAt: v.optional(v.number()),
    /** Unpublished commits already created for the active burst. */
    staged: v.optional(v.string()),
    stagedCount: v.optional(v.number()),
    stagedRef: v.optional(v.string()),
    /** A staged commit of the active burst touched .github/workflows/: its tip token asks for workflows. */
    stagedWorkflows: v.optional(v.literal(true)),
    batchThrough: v.optional(v.number()),
    burstFirstAt: v.optional(v.number()),
    /** A bounded wait belongs to the oldest unpublished State. */
    hold: v.optional(v.object({ firstAt: v.number(), until: v.number(), red: v.boolean() })),
    checkWalls: v.optional(
      v.array(v.object({ runId: v.string(), at: v.number(), milliseconds: v.number() })),
    ),
    queuedPublishes: v.optional(v.number()),
    pendingVerify: v.optional(v.number()),
    burstJobId: v.optional(v.id('projectGithubMirrorJobs')),
    newestPublish: v.optional(v.number()),
    flushThrough: v.optional(v.number()),
    revertThrough: v.optional(v.number()),
    verifyError: v.optional(v.string()),
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
  /** One row while a terminally failed publish holds the mirror (Item 67771ca6, friction 28e84c06).
   * Written only when a job stops and deleted on resume, so a landed reply that asks reads one
   * index range that no healthy mirror write ever changes. */
  projectGithubMirrorStops: defineTable({
    projectId: v.id('hostedProjects'),
    jobId: v.id('projectGithubMirrorJobs'),
  }).index('by_project', ['projectId']),
  projectGithubMirrorJobs: defineTable({
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    sequence: v.number(),
    repository: v.string(),
    authorityEpoch: v.number(),
    repositoryKey: v.optional(v.string()),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('retrying'),
      v.literal('failed'),
      v.literal('done'),
    ),
    state: v.string(),
    acceptedAt: v.optional(v.number()),
    exactCheck: v.optional(v.literal(true)),
    burstJobId: v.optional(v.id('projectGithubMirrorJobs')),
    burstPublished: v.optional(v.literal(true)),
    verify: v.optional(v.union(v.literal('pending'), v.literal('success'), v.literal('failure'))),
    verifyError: v.optional(v.string()),
    verifySent: v.optional(v.union(v.literal('pending'), v.literal('success'), v.literal('failure'))),
    verifyLink: v.optional(v.string()),
    /** Only lagging CI checks add a wake on completion; healthy mirrors do no extra reads. */
    ciWaiters: v.optional(v.literal(true)),
    seed: v.optional(v.string()),
    blobOnly: v.optional(v.literal(true)),
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
    /** Signed GitHub identity pins and the Forge member who triggered this run. */
    pullRepositoryId: v.optional(v.number()),
    pullMember: v.optional(v.string()),
    /** The GitHub tree verified by this job. A bounded merge lookup still verifies the PR head. */
    pullTree: v.optional(v.string()),
    /** The compose operation, then the check run, a pull request job waits on (one indexed
     * read when either settles, never a poll). */
    waitKey: v.optional(v.string()),
  })
    .index('by_project_and_state', ['projectId', 'state'])
    .index('by_project_and_pull', ['projectId', 'pullKey'])
    .index('by_project_and_pull_tree', ['projectId', 'pullTree'])
    .index('by_project_and_wait', ['projectId', 'waitKey'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_repository_and_verify_and_sequence', [
      'projectId',
      'repositoryKey',
      'verify',
      'sequence',
    ])
    .index('by_project_and_repository_and_verify_error', ['projectId', 'repositoryKey', 'verifyError'])
    .index('by_project_and_status_and_sequence', ['projectId', 'status', 'sequence']),
};
