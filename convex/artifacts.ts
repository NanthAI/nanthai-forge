// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export async function trackArtifact(ctx: MutationCtx, importId: Id<'imports'>, key: string | undefined) {
  if (!key) return;
  const artifactKey = key as Id<'_storage'>;
  const previous = await ctx.db
    .query('importArtifacts')
    .withIndex('by_importId_and_artifactKey', q => q.eq('importId', importId).eq('artifactKey', artifactKey))
    .unique();
  if (!previous) await ctx.db.insert('importArtifacts', { importId, artifactKey });
}
