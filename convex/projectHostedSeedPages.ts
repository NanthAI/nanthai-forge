// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { ObjectView } from './projectObjectFind';
import { storeCatalogObjects } from './projectObjectCatalogStore';
import { validStateSize, type StateSize } from '../src/state/size';
import { invariant } from '../src/errors';

const hashesPerRow = 64;
const hashLength = 64;
const blockStart = (index: number) => index - (index % hashesPerRow);
const receipt = (ctx: MutationCtx, seedId: Doc<'projectHostedSeeds'>['_id'], index: number) =>
  ctx.db
    .query('projectHostedSeedPages')
    .withIndex('by_seed_and_index', q => q.eq('seedId', seedId).eq('index', index))
    .unique();

export async function replaySeedPage(
  ctx: MutationCtx,
  seed: Doc<'projectHostedSeeds'>,
  index: number,
  previous: string,
  body: string,
  chain: string,
) {
  const start = seed.objectCatalog ? blockStart(index) : index;
  const row = await receipt(ctx, seed._id, start);
  const offset = (index - start) * hashLength;
  invariant(
    row &&
      (seed.objectCatalog
        ? row.body.slice(offset, offset + hashLength) === chain
        : row.body === body && row.previous === previous && row.chain === chain),
    'WORK_OPERATION_CHANGED',
    'Retry the original committed page.',
  );
}

export async function commitCatalogSeedPage(
  ctx: MutationCtx,
  seed: Doc<'projectHostedSeeds'>,
  input: {
    index: number;
    previous: string;
    rootStates?: string[];
    stateSizes?: ({ sha256: string; size: number } & StateSize)[];
  },
  chain: string,
  objects: (ObjectView | null)[],
) {
  const byDigest = new Map(objects.flatMap(row => (row ? [[row.digest, row] as const] : [])));
  const roots = new Set(input.rootStates);
  const pins: Parameters<typeof storeCatalogObjects>[2] = [];
  for (const { sha256, size, fileCount, manifestBytes } of input.stateSizes ?? []) {
    const row = byDigest.get(sha256);
    const stateSize = { fileCount, manifestBytes };
    invariant(
      row &&
        row.size === size &&
        validStateSize(stateSize) &&
        manifestBytes === size &&
        (!row.stateSize ||
          (row.stateSize.fileCount === fileCount && row.stateSize.manifestBytes === manifestBytes)) &&
        (!roots.has(sha256) || row.stateGeneration === undefined || row.stateGeneration === 1),
      'SOURCE_HASH_MISMATCH',
      'Verified State dimensions or generation differ from the original pin.',
    );
    const stateGeneration = roots.has(sha256) ? { stateGeneration: 1 } : {};
    if (row._id) await ctx.db.patch(row._id, { stateSize, ...stateGeneration });
    else
      pins.push({
        digest: sha256,
        size,
        stateSize,
        ...stateGeneration,
        ...(row.pack ? { pack: row.pack } : {}),
        ...(row.recipe ? { recipe: row.recipe } : {}),
      });
  }
  if (pins.length) await storeCatalogObjects(ctx, seed.projectId, pins, seed.operationId, true);

  // Each chain hash commits to the prior hash, index and exact canonical pins.
  // Group the immutable replay proofs while the seed cursor advances atomically.
  const index = blockStart(input.index);
  if (index === input.index)
    await ctx.db.insert('projectHostedSeedPages', {
      projectId: seed.projectId,
      seedId: seed._id,
      index,
      previous: input.previous,
      body: chain,
      chain,
    });
  else {
    const old = await receipt(ctx, seed._id, index);
    invariant(old?.chain === input.previous, 'WORK_OPERATION_CHANGED', 'Resume the original seed page.');
    await ctx.db.patch(old._id, { body: old.body + chain, chain });
  }
}
