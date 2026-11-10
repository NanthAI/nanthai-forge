// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** GitHub REST requests this import made, by who paid (src/github-import-meter.ts). */
export const githubRequests = v.object({
  user: v.number(),
  app: v.number(),
  server: v.number(),
  anonymous: v.number(),
  userWindow: v.optional(v.object({ reset: v.number(), used: v.number(), limit: v.number() })),
});
/** A structured failure; `retryAt` (ms) names a provider reset when one applies. */
export const githubImportError = v.object({
  code: v.string(),
  message: v.string(),
  retryAt: v.optional(v.number()),
});
export const githubImportFields = {
  protocol: v.optional(v.union(v.literal(2), v.literal(3))),
  publication: v.optional(
    v.object({
      backupId: v.id('projectBackups'),
      generationId: v.id('projectWorkGenerations'),
      head: v.string(),
      root: v.string(),
    }),
  ),
  /** Archive imports: the portable State object (path -> blob map) once it is stored, so a
   * publication retry rebuilds its rows from stored objects instead of streaming the archive. */
  stateObject: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  /** Archive imports: the commit tree's file table in R2, listed once per job. */
  listing: v.optional(v.object({ sha256: v.string(), size: v.number() })),
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
  submodules: v.optional(v.number()),
  error: v.optional(githubImportError),
  githubRequests: v.optional(githubRequests),
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
