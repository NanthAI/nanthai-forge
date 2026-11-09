// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const githubBindingTables = {
  projectGithubBindings: defineTable({
    projectId: v.id('hostedProjects'),
    repoId: v.number(),
    fullName: v.string(),
    installationId: v.number(),
    boundBy: v.string(),
    boundAt: v.number(),
    /** The connecting person's GitHub role then; only Admin can import the two-way ruleset. */
    role: v.optional(v.union(v.literal('admin'), v.literal('maintain'))),
  })
    .index('by_repo', ['repoId'])
    .index('by_project_and_name', ['projectId', 'fullName'])
    .index('by_project_and_installation', ['projectId', 'installationId']),
  githubBindingInstallations: defineTable({
    installationId: v.number(),
    revision: v.number(),
    removed: v.boolean(),
  }).index('by_installation', ['installationId']),
  githubBindingOperations: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    actor: v.string(),
    repository: v.string(),
    // Pinned by the callback after the user proves repository access.
    installationId: v.optional(v.number()),
    // GitHub account ids linked to the starting Forge account; the callback
    // completes only for one of them.
    githubAccounts: v.optional(v.array(v.string())),
    state: v.string(),
    verifier: v.string(),
    authorizeUrl: v.string(),
    status: v.union(
      v.literal('waiting'),
      v.literal('processing'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    revision: v.optional(v.number()),
    repoId: v.optional(v.number()),
    code: v.optional(v.string()),
    /** The connect asks for the GitHub mirror (publish and two-way) on this repository; the owner's
     * authorization is its approval. Absent on operations started without it. */
    mirror: v.optional(v.boolean()),
    /** What `complete` did about it: turned on, or left alone because a mirror was already set. */
    mirrorResult: v.optional(v.union(v.literal('enabled'), v.literal('kept'))),
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_state', ['state']),
  // One per Forge owner and runner repository: that owner's projects may run checks on
  // the repository (Actions only; the mirror needs a project binding). Written by
  // configure-runner after the App proves the owner's linked GitHub account administers it.
  githubRunnerGrants: defineTable({
    owner: v.string(),
    repoId: v.number(),
    fullName: v.string(),
    installationId: v.number(),
    githubAccount: v.string(),
    grantedAt: v.number(),
  })
    .index('by_owner_and_name', ['owner', 'fullName'])
    .index('by_owner_and_repo', ['owner', 'repoId'])
    .index('by_repo', ['repoId']),
  githubBindingWebhookReceipts: defineTable({ delivery: v.string() }).index('by_delivery', ['delivery']),
  /** Last GitHub visibility read of a runner repository (lowercase OWNER/NAME), reused
   * for `runnerVisibilityTtlMs`; one row per repository, overwritten in place. */
  githubRepositoryVisibility: defineTable({
    repository: v.string(),
    visibility: v.string(),
    checkedAt: v.number(),
  }).index('by_repository', ['repository']),
  githubBindingRemovals: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    repoId: v.number(),
    actor: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
