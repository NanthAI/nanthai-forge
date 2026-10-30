// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { r2Key } from './r2';
import { isR2Object } from './projectObjectFields';
export type SourceOutput = {
  sha256: string;
  size: number;
  storageId?: Id<'_storage'>;
  r2Key?: string;
  recipe?: { sha256: string; size: number };
};
export async function storeSourceOutputs(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  executionId: string,
  objects: SourceOutput[],
) {
  for (const pin of objects) {
    invariant(
      [pin.storageId, pin.recipe, pin.r2Key].filter(Boolean).length === 1,
      'SOURCE_JOB_INVALID',
      'Output needs one physical encoding.',
    );
    if (pin.storageId) {
      const metadata = await ctx.storage.getMetadata(pin.storageId);
      invariant(
        metadata?.sha256 === pin.sha256 && metadata.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Worker storage pin changed.',
      );
    } else if (pin.r2Key) {
      // Only the trusted action calls this after checksum-bound PUT and HEAD.
      invariant(
        pin.r2Key === r2Key(projectId, pin.sha256),
        'SOURCE_HASH_MISMATCH',
        'Source output project binding changed.',
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
    const encoding = pin.r2Key
      ? { location: 'r2' as const, r2Key: pin.r2Key, r2Committed: true, recipe: undefined }
      : pin.storageId
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
    else if (
      (pin.r2Key && (!isR2Object(old) || old.r2Key !== pin.r2Key || old.recipe || old.removed)) ||
      old.removed ||
      (!old.storageId && !old.recipe && !old.r2Committed)
    )
      await ctx.db.patch(old._id, {
        ...encoding,
        ...(!pin.r2Key ? { location: undefined, r2Key: undefined, r2Committed: undefined } : {}),
        removed: false,
        sourceReferenced: true,
      });
    else if (!old.sourceReferenced) await ctx.db.patch(old._id, { sourceReferenced: true });
    if (!old?.sourceReferenced)
      await ctx.db.insert('projectCheckLogSourcePins', { projectId: projectId, digest: pin.sha256 });
  }
}
