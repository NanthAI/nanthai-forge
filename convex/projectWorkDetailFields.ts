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
    /** The new base's catalog root and whole Work, recorded before they are written (Item b6588425 line 2e): a copy
     * of every word, so purges refuse to start while it is here, and the migration deletes it when it is rejected
     * (`pending`: the R2 work of the batch being deleted). */
    staged: v.optional(
      v.object({
        root: v.object({ sha256: v.string(), size: v.number() }),
        work: v.object({ sha256: v.string(), size: v.number() }),
        at: v.number(),
        /** The step invocation that staged it: only it may publish the copy (a stale one cannot). */
        token: v.string(),
        pending: v.optional(
          v.object({
            deletes: v.array(v.string()),
            zero: v.array(v.object({ key: v.string(), offset: v.number(), size: v.number() })),
          }),
        ),
      }),
    ),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
