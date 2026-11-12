// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { CatalogObject } from './projectObjectFind';
import { r2ObjectKey } from './r2';
import { packHeaders, packRange } from '../src/object-pack-range';
import { invariant } from '../src/errors';
// Slim point records share the retained receipt table and its exact-key index.
// A future bounded writer publishes this header before moving any descriptors.
// Until then one empty header read per request preserves every legacy lookup.
const modes = new WeakMap<QueryCtx, Map<string, Promise<boolean>>>();
export function clearPointObjectCache(ctx: QueryCtx) {
  modes.delete(ctx);
}
async function enabled(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  let projects = modes.get(ctx);
  if (!projects) modes.set(ctx, (projects = new Map()));
  let pending = projects.get(projectId);
  if (!pending) {
    pending = (async () => {
      const row = await ctx.db
        .query('projectObjectReceipts')
        .withIndex('by_key', q => q.eq('key', `source-points:${projectId}`))
        .unique();
      if (!row) return false;
      invariant(
        row.projectId === projectId && row.value === '1',
        'SOURCE_HASH_MISMATCH',
        'Source point authority differs from its project/version.',
      );
      return true;
    })();
    projects.set(projectId, pending);
  }
  return pending;
}
/** Point hits are complete physical bindings. A miss still consults the legacy
 * catalog; this reader never retires it or interprets incomplete migration as absence. */
export async function findPointObjects(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  digests: readonly string[],
): Promise<Map<string, CatalogObject>> {
  const result = new Map<string, CatalogObject>();
  if (!digests.length || !(await enabled(ctx, projectId))) return result;
  const rows = await Promise.all(
    digests.map(digest =>
      ctx.db
        .query('projectObjectReceipts')
        .withIndex('by_key', q => q.eq('key', `source-point:${projectId}:${digest}`))
        .unique(),
    ),
  );
  for (const [index, row] of rows.entries()) {
    if (!row) continue;
    const digest = digests[index]!,
      binding = row.sourceBinding;
    invariant(
      row.projectId === projectId &&
        row.value === digest &&
        binding &&
        Number.isSafeInteger(row.size) &&
        row.size! >= 0,
      'SOURCE_HASH_MISMATCH',
      'Stored source point binding differs from its identity.',
    );
    const base = {
      projectId,
      digest,
      size: row.size!,
      nonce: row.nonce ?? '',
      removed: false,
      sourceReferenced: true,
    };
    if ('r2Key' in binding) {
      invariant(
        r2ObjectKey(projectId, binding.r2Key)?.digest === (binding.pack?.digest ?? digest),
        'SOURCE_HASH_MISMATCH',
        'Stored source point has a different project key.',
      );
      if (binding.pack) packHeaders(packRange(binding), base.size);
      result.set(digest, {
        ...base,
        location: 'r2',
        r2Committed: true,
        r2Key: binding.r2Key,
        ...(binding.pack ? { pack: binding.pack } : {}),
      });
    } else {
      invariant(
        /^[a-f0-9]{64}$/.test(binding.recipe.digest) &&
          Number.isSafeInteger(binding.recipe.size) &&
          binding.recipe.size >= 0,
        'SOURCE_HASH_MISMATCH',
        'Stored source point recipe differs from its pin.',
      );
      result.set(digest, { ...base, recipe: binding.recipe });
    }
  }
  return result;
}
