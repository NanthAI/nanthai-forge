// SPDX-License-Identifier: Apache-2.0
import type { StateSize } from '../src/state/size';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { packHeaders, packRange, type ObjectPack } from '../src/object-pack-range';
import { r2Key } from './r2';
import { isR2Object } from './projectObjectFields';
import { validStateGeneration, validStateParents } from '../src/state/generation';
import { validateRecipeClosure } from './projectRecipeClosure';
import { findObject, findObjects, objectRow } from './projectObjectFind';
export type SourceOutput = {
  sha256: string;
  size: number;
  stateGeneration?: number;
  stateSize?: StateSize;
  stateParents?: string[];
  statePhysical?: { sha256: string; size: number };
  storageId?: Id<'_storage'>;
  r2Key?: string;
  recipe?: { sha256: string; size: number };
  recipeClosure?: { sha256: string; size: number; pack?: ObjectPack }[];
  pack?: ObjectPack;
  physical?: { sha256: string; size: number; r2Key: string; pack?: ObjectPack }[];
};
export async function storeSourceOutputs(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  executionId: string,
  objects: SourceOutput[],
) {
  // Physical leaves/metadata ride on their logical output in the existing commit.
  // This avoids per-chunk staging calls; all protection changes are atomic here.
  let fence: string | undefined;
  const packs = new Map<string, Awaited<ReturnType<typeof findObject>>>();
  const staged: SourceOutput[] = objects.flatMap(pin => [...(pin.physical ?? []), pin]);
  for (const pin of staged) {
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
      // The fixed action supplies checksum-confirmed bodies or hash-verified
      // ranges in an existing committed project body.
      invariant(
        pin.r2Key === r2Key(projectId, pin.pack?.digest ?? pin.sha256),
        'SOURCE_HASH_MISMATCH',
        'Source output project binding changed.',
      );
      if (pin.pack) {
        packHeaders(packRange(pin), pin.size);
        let pack = packs.get(pin.pack.digest);
        if (!pack) {
          pack = await findObject(ctx, projectId, pin.pack.digest);
          packs.set(pin.pack.digest, pack);
        }
        invariant(
          pack &&
            !pack.removed &&
            isR2Object(pack) &&
            !pack.pack &&
            pack.size === pin.pack.size &&
            pack.r2Key === r2Key(projectId, pin.pack.digest),
          'SOURCE_HASH_MISMATCH',
          'Source pack is not committed in this project.',
        );
        if (!pack.sourceReferenced) {
          await ctx.db.patch((await objectRow(ctx, pack))._id, { sourceReferenced: true });
          fence = pack.digest;
          packs.set(pack.digest, { ...pack, sourceReferenced: true });
        }
      }
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
    let closure = pin.recipeClosure;
    if (pin.recipeClosure) {
      invariant(pin.recipe, 'SOURCE_JOB_INVALID', 'Only a recipe has a leaf closure.');
      validateRecipeClosure(pin, pin.recipeClosure);
      const leaves = await findObjects(
        ctx,
        projectId,
        pin.recipeClosure.map(leaf => leaf.sha256),
      );
      invariant(
        leaves.every(
          (leaf, i) =>
            leaf &&
            !leaf.removed &&
            isR2Object(leaf) &&
            leaf.size === pin.recipeClosure![i]!.size &&
            leaf.r2Key === r2Key(projectId, leaf.pack?.digest ?? leaf.digest),
        ),
        'SOURCE_HASH_MISMATCH',
        'Worker closure contains an unstaged leaf.',
      );
      closure = leaves.map(leaf => ({
        sha256: leaf!.digest,
        size: leaf!.size,
        ...(leaf!.pack ? { pack: leaf!.pack } : {}),
      }));
    }
    const encoding = pin.r2Key
      ? { location: 'r2' as const, r2Key: pin.r2Key, r2Committed: true, recipe: undefined, pack: pin.pack }
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
    invariant(!old || old.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Stored source size changed.');
    if (pin.statePhysical) {
      const root = await findObject(ctx, projectId, pin.statePhysical.sha256);
      invariant(
        root &&
          !root.removed &&
          isR2Object(root) &&
          !root.pack &&
          root.size === pin.statePhysical.size &&
          root.r2Key === r2Key(projectId, root.digest),
        'SOURCE_HASH_MISMATCH',
        'Physical manifest root is not committed in this project.',
      );
      invariant(
        !old?.statePhysical ||
          (old.statePhysical.sha256 === pin.statePhysical.sha256 &&
            old.statePhysical.size === pin.statePhysical.size),
        'SOURCE_HASH_MISMATCH',
        'Immutable State physical manifest changed.',
      );
    }
    // Written once from the hash-verified manifest, like the generation; never cleared.
    const graph = {
      ...(closure === undefined ? {} : { recipeClosure: closure }),
      ...(pin.stateGeneration === undefined ? {} : { stateGeneration: pin.stateGeneration }),
      ...(pin.stateParents === undefined ? {} : { stateParents: pin.stateParents }),
      ...(pin.statePhysical === undefined ? {} : { statePhysical: pin.statePhysical }),
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
      (old.statePhysical === undefined && pin.statePhysical !== undefined) ||
      (old.recipeClosure === undefined && pin.recipeClosure !== undefined)
    )
      await ctx.db.patch((await objectRow(ctx, old))._id, { sourceReferenced: true, ...graph });
    if (!old?.sourceReferenced) fence = pin.sha256;
  }
  if (fence) await ctx.db.insert('projectCheckLogSourcePins', { projectId, digest: fence });
}
