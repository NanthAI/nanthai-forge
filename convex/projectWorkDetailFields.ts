// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const workDetailMigration = v.object({
  operationId: v.string(),
  backupId: v.id('projectBackups'),
  revision: v.number(),
  root: v.object({ sha256: v.string(), size: v.number() }),
});
export const workDetailTables = {
  projectWorkDetailMigrations: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    backupId: v.id('projectBackups'),
    revision: v.number(),
    authority: v.string(),
    collection: v.number(),
    offset: v.number(),
    pages: v.union(v.object({ sha256: v.string(), size: v.number() }), v.null()),
    root: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project', ['projectId']),
};
