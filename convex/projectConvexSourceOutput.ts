// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
export type SourceOutput = {
  sha256: string;
  size: number;
  storageId?: Id<'_storage'>;
  recipe?: { sha256: string; size: number };
};
export async function storeSourceOutputs(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  executionId: string,
  objects: SourceOutput[],
) {
  for (const pin of objects) {
    invariant(!!pin.storageId !== !!pin.recipe, 'SOURCE_JOB_INVALID', 'Output needs one physical encoding.');
    if (pin.storageId) {
      const metadata = await ctx.storage.getMetadata(pin.storageId);
      invariant(
        metadata?.sha256 === pin.sha256 && metadata.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Worker storage pin changed.',
      );
    } else {
      const recipe = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q =>
          q.eq('projectId', projectId).eq('digest', pin.recipe!.sha256),
        )
        .unique();
      invariant(
        recipe &&
          !recipe.removed &&
          recipe.size === pin.recipe!.size &&
          (recipe.storageId || recipe.r2Committed),
        'SOURCE_HASH_MISMATCH',
        'Worker recipe is not staged.',
      );
    }
    const encoding = pin.storageId
      ? { storageId: pin.storageId, recipe: undefined }
      : { storageId: undefined, recipe: { digest: pin.recipe!.sha256, size: pin.recipe!.size } };
    const old = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', pin.sha256))
      .unique();
    invariant(!old || old.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Stored source size changed.');
    if (!old)
      await ctx.db.insert('projectObjects', {
        projectId: projectId,
        digest: pin.sha256,
        size: pin.size,
        ...encoding,
        nonce: executionId,
        removed: false,
        sourceReferenced: true,
      });
    else if (old.removed || (!old.storageId && !old.recipe && !old.r2Committed))
      await ctx.db.patch(old._id, {
        ...encoding,
        location: undefined,
        r2Key: undefined,
        r2Committed: undefined,
        removed: false,
        sourceReferenced: true,
      });
    else if (!old.sourceReferenced) await ctx.db.patch(old._id, { sourceReferenced: true });
    if (!old?.sourceReferenced)
      await ctx.db.insert('projectCheckLogSourcePins', { projectId: projectId, digest: pin.sha256 });
  }
}
