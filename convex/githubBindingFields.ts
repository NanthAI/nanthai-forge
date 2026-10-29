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
    installationId: v.number(),
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
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_state', ['state']),
  githubBindingWebhookReceipts: defineTable({ delivery: v.string() }).index('by_delivery', ['delivery']),
  githubBindingRemovals: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    repoId: v.number(),
    actor: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
