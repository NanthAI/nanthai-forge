// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { catalogPages, clearObjectCatalogCache } from './projectObjectFind';
import { pointMode } from './projectObjectPoints';
import { storePointObjects } from './projectObjectPointStore';
import { windowEntries } from './projectGithubImportCatalog';
import { r2Key } from './r2';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
type Entry = Parameters<typeof catalogPages>[0][number];
/** Only immutable, protected source descriptors. State ancestry, pending uploads,
 * legacy storage and rotated cleanup keys retain their original mutable row. */
export function catalogEligible(row: Doc<'projectObjects'>) {
  return (
    row.sourceReferenced === true &&
    !row.removed &&
    !row.storageId &&
    !row.packMembers &&
    row.stateGeneration === undefined &&
    row.stateParents === undefined &&
    row.stateSize === undefined &&
    row.statePhysical === undefined &&
    row.stateTree === undefined &&
    row.recipeClosure === undefined &&
    !row.r2SweepKey &&
    !row.r2BackfillOperationId &&
    (!!row.recipe ||
      (row.location === 'r2' &&
        row.r2Committed === true &&
        row.r2Key === r2Key(row.projectId, row.pack?.digest ?? row.digest)))
  );
}
export function catalogPin(row: Doc<'projectObjects'>): Entry {
  return {
    digest: row.digest,
    size: row.size,
    ...(row.recipe ? { recipe: row.recipe } : {}),
    ...(row.pack ? { pack: row.pack } : {}),
  };
}
/** Merge sorted pins into their covering page or the gap before the next page.
 * Each group reads at most two existing pages and writes at most two pages for a
 * 256-pin input. Existing page ranges never overlap, including sparse catalogs. */
export async function storeCatalogObjects(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  pins: Entry[],
  origin: string,
) {
  if (await pointMode(ctx, projectId)) {
    const objects = pins.map(pin => ({
      ...pin,
      projectId,
      nonce: '',
      removed: false,
      sourceReferenced: true,
      ...(pin.recipe
        ? {}
        : {
            location: 'r2' as const,
            r2Committed: true,
            r2Key: r2Key(projectId, pin.pack?.digest ?? pin.digest),
          }),
    }));
    const saved = await storePointObjects(ctx, projectId, objects);
    return { bytes: saved.bytes, pages: 0, readBytes: saved.readBytes };
  }
  let pending = [...pins].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  let bytes = 0,
    pages = 0,
    readBytes = 0;
  while (pending.length) {
    const first = pending[0]!.digest;
    const [previous] = await ctx.db
      .query('projectObjectCatalog')
      .withIndex('by_project_and_first', q => q.eq('projectId', projectId).lte('first', first))
      .order('desc')
      .take(1);
    const covering = previous && previous.last >= first ? previous : undefined;
    const [next] = covering
      ? []
      : await ctx.db
          .query('projectObjectCatalog')
          .withIndex('by_project_and_first', q => q.eq('projectId', projectId).gt('first', first))
          .take(1);
    const merging = covering ?? (previous && previous.sizes.length < 256 ? previous : undefined);
    for (const row of [previous, next])
      if (row) readBytes += new TextEncoder().encode(JSON.stringify(row)).length;
    const group = pending.filter(pin =>
      covering ? pin.digest <= covering.last : !next || pin.digest < next.first,
    );
    pending = pending.slice(group.length);
    const entries = new Map<string, Entry>(
      (merging ? windowEntries(JSON.stringify(merging)) : []).map(pin => [pin.digest, pin]),
    );
    for (const pin of group) {
      const old = entries.get(pin.digest);
      invariant(
        !old ||
          (old.size === pin.size &&
            canonicalPayload(old.recipe ?? null) === canonicalPayload(pin.recipe ?? null) &&
            canonicalPayload(old.pack ?? null) === canonicalPayload(pin.pack ?? null)),
        'SOURCE_HASH_MISMATCH',
        'Immutable catalog binding changed.',
      );
      if (!old) entries.set(pin.digest, pin);
    }
    const rows = catalogPages([...entries.values()]);
    // Preserve the original first row id; source lookup caches are request-local
    // and invalidated after publication, so subsequent writes see the new ranges.
    for (const [index, page] of rows.entries()) {
      const value = { projectId, ...page, origin: merging?.origin ?? origin };
      bytes += new TextEncoder().encode(JSON.stringify(value)).length;
      if (index === 0 && merging) await ctx.db.replace(merging._id, value);
      else await ctx.db.insert('projectObjectCatalog', value);
      pages++;
    }
    clearObjectCatalogCache(ctx);
  }
  return { bytes, pages, readBytes };
}
