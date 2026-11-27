// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';

/** The seed commit selects its backup in the same transaction that checks the pinned Work import. */
export async function selectedSeedWork(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
) {
  if (project.currentBackup !== backupId) return false;
  const seed = await ctx.db
    .query('projectHostedSeeds')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .unique();
  return (
    seed?.backupId === backupId &&
    seed.workImport !== undefined &&
    seed.workImport.next === seed.workImport.total
  );
}
