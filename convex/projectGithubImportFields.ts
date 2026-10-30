// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const githubImportFields = {
  protocol: v.optional(v.literal(2)),
  publication: v.optional(
    v.object({
      backupId: v.id('projectBackups'),
      generationId: v.id('projectWorkGenerations'),
      head: v.string(),
      root: v.string(),
    }),
  ),
  visibility: v.union(v.literal('public'), v.literal('private')),
  owner: v.string(),
  operationId: v.string(),
  request: v.string(),
  projectId: v.id('hostedProjects'),
  repository: v.string(),
  commit: v.string(),
  at: v.string(),
  step: v.number(),
  cursor: v.string(),
  phase: v.union(v.literal('discovering'), v.literal('importing'), v.literal('ready'), v.literal('error')),
  totalKnown: v.boolean(),
  completed: v.number(),
  total: v.number(),
  bytes: v.number(),
  totalBytes: v.number(),
  error: v.optional(v.object({ code: v.string(), message: v.string() })),
  task: v.optional(v.id('_scheduled_functions')),
};
export const githubImportDocument = v.object({
  _id: v.id('projectGithubImports'),
  _creationTime: v.number(),
  ...githubImportFields,
});
export const githubImportTables = {
  projectGithubImportInventory: defineTable({
    projectId: v.id('hostedProjects'),
    jobId: v.id('projectGithubImports'),
    part: v.string(),
    key: v.string(),
    position: v.number(),
    value: v.string(),
  })
    .index('by_job_and_part_and_key', ['jobId', 'part', 'key'])
    .index('by_job_and_part_and_position', ['jobId', 'part', 'position'])
    .index('by_project', ['projectId']),
  projectGithubImports: defineTable(githubImportFields)
    .index('by_owner_and_operation', ['owner', 'operationId'])
    .index('by_project', ['projectId']),
};
