// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { r2Key } from './r2';
import { isR2Object } from './projectObjectFields';
import { validStateGeneration, validStateParents } from '../src/state-generation';
import { findObject, objectRow } from './projectObjectFind';
import { validStateTreePointer, type StateTreePointer } from '../src/state-tree-store';
export type SourceOutput = {
  sha256: string;
  size: number;
  stateGeneration?: number;
  stateParents?: string[];
  stateTree?: StateTreePointer;
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
      const recipe = await findObject(ctx, projectId, pin.recipe!.sha256);
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
    const old = await findObject(ctx, projectId, pin.sha256);
    invariant(
      pin.stateGeneration === undefined || validStateGeneration(pin.stateGeneration),
      'SOURCE_JOB_INVALID',
      'State generation must be an exact positive level.',
    );
    invariant(
      old?.stateGeneration === undefined ||
        pin.stateGeneration === undefined ||
        old.stateGeneration === pin.stateGeneration,
      'SOURCE_HASH_MISMATCH',
      'Immutable State generation changed.',
    );
    invariant(
      pin.stateParents === undefined || validStateParents(pin.stateParents),
      'SOURCE_JOB_INVALID',
      'State parents must be exact distinct digests.',
    );
    invariant(
      old?.stateParents === undefined ||
        pin.stateParents === undefined ||
        old.stateParents.join() === pin.stateParents.join(),
      'SOURCE_HASH_MISMATCH',
      'Immutable State parents changed.',
    );
    invariant(
      pin.stateTree === undefined || validStateTreePointer(pin.stateTree),
      'SOURCE_JOB_INVALID',
      'A State tree pointer names an exact segment and root.',
    );
    // Written once: a State that already has a proven pointer keeps it (the tree is immutable).
    const tree = old?.stateTree ? undefined : pin.stateTree;
    invariant(!old || old.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Stored source size changed.');
    // Written once from the hash-verified manifest, like the generation; never cleared.
    const graph = {
      ...(pin.stateGeneration === undefined ? {} : { stateGeneration: pin.stateGeneration }),
      ...(pin.stateParents === undefined ? {} : { stateParents: pin.stateParents }),
      ...(tree === undefined ? {} : { stateTree: tree }),
    };
    if (!old)
      await ctx.db.insert('projectObjects', {
        projectId: projectId,
        digest: pin.sha256,
        size: pin.size,
        ...graph,
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
      await ctx.db.patch((await objectRow(ctx, old))._id, {
        ...encoding,
        ...graph,
        ...(!pin.r2Key ? { location: undefined, r2Key: undefined, r2Committed: undefined } : {}),
        removed: false,
        sourceReferenced: true,
      });
    else if (
      !old.sourceReferenced ||
      (old.stateGeneration === undefined && pin.stateGeneration !== undefined) ||
      (old.stateParents === undefined && pin.stateParents !== undefined) ||
      tree !== undefined
    )
      await ctx.db.patch((await objectRow(ctx, old))._id, { sourceReferenced: true, ...graph });
    if (!old?.sourceReferenced)
      await ctx.db.insert('projectCheckLogSourcePins', { projectId: projectId, digest: pin.sha256 });
  }
}
