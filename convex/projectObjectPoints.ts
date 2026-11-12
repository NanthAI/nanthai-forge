// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { CatalogObject } from './projectObjectFind';
import { pointObject } from './projectObjectPointBinding';
import { invariant } from '../src/errors';
// Slim point records share the retained receipt table and its exact-key index.
// Format 1 retains mixed catalog fallback; format 2 is published only after
// every dense page and original-id receipt has an authoritative equivalent.
const modes = new WeakMap<QueryCtx, Map<string, Promise<false | 1 | 2>>>();
export function clearPointObjectCache(ctx: QueryCtx) {
  modes.delete(ctx);
}
export async function pointMode(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
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
        row.projectId === projectId && (row.value === '1' || row.value === '2'),
        'SOURCE_HASH_MISMATCH',
        'Source point authority differs from its project/version.',
      );
      return row.value === '2' ? (2 as const) : (1 as const);
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
  if (!digests.length || !(await pointMode(ctx, projectId))) return result;
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
    const digest = digests[index]!;
    invariant(
      row.key === `source-point:${projectId}:${digest}`,
      'SOURCE_HASH_MISMATCH',
      'Stored source point key differs from its identity.',
    );
    result.set(digest, pointObject(row, projectId, digest));
  }
  return result;
}
