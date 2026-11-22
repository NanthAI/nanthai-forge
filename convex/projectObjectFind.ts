// SPDX-License-Identifier: Apache-2.0
import { isStored } from './projectObjectFields';
import type { StateSize } from '../src/state/size';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { r2Key } from './r2';
import { findPointObjects, clearPointObjectCache, pointMode } from './projectObjectPoints';
import type { ObjectPack } from '../src/object-pack-range';
import { ForgeError } from '../src/errors';
import { purgedMessage } from '../src/save-purge';

/** Objects per catalog row (~19 KB): a lookup reads one small document. */
export const objectCatalogPage = 256;
/** A catalog entry: stored, immutable, no row (`_id` undefined). */
export type CatalogObject = Omit<Doc<'projectObjects'>, '_id' | '_creationTime'> & {
  _id?: undefined;
  _creationTime?: undefined;
};
/** A stored object: its own row, or a catalog entry. */
export type ObjectView = Doc<'projectObjects'> | CatalogObject;
/** A stored object may serve as a State only after trusted source registration. */
export async function isRegisteredState(ctx: QueryCtx, row: ObjectView) {
  return (
    row.stateGeneration !== undefined ||
    !!row.statePhysical ||
    !!(await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', row.projectId).eq('head', row.digest))
      .unique())
  );
}

type Page = Doc<'projectObjectCatalog'>;
const digestPattern = /^[0-9a-f]{64}$/;

function entry(page: Page, digest: string): CatalogObject | null {
  let low = 0,
    high = page.sizes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1,
      found = page.digests.slice(middle * 64, middle * 64 + 64);
    if (found === digest) {
      const recipe = page.recipes.find(row => row.index === middle);
      const packed = page.packs?.find(row => row.index === middle);
      const pack = packed && { digest: packed.digest, size: packed.size, offset: packed.offset };
      return {
        projectId: page.projectId,
        digest,
        size: page.sizes[middle]!,
        ...(page.stateGenerations?.some(row => row.index === middle)
          ? { stateGeneration: page.stateGenerations.find(row => row.index === middle)!.generation }
          : {}),
        ...(page.stateSizes?.find(row => row.index === middle)
          ? {
              stateSize: (({ fileCount, manifestBytes }) => ({ fileCount, manifestBytes }))(
                page.stateSizes.find(row => row.index === middle)!,
              ),
            }
          : {}),
        nonce: '',
        removed: false,
        sourceReferenced: true,
        ...(recipe
          ? { recipe: { digest: recipe.digest, size: recipe.size } }
          : {
              location: 'r2' as const,
              r2Key: r2Key(page.projectId, pack?.digest ?? digest),
              r2Committed: true,
              ...(pack ? { pack } : {}),
            }),
      };
    }
    if (found < digest) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}
// Function contexts are request-local. Catalog writers invalidate this cache, so one
// request reads each catalog row at most once however many digests it resolves.
const requests = new WeakMap<QueryCtx, Page[]>();
export function clearObjectCatalogCache(ctx: QueryCtx) {
  requests.delete(ctx);
  clearPointObjectCache(ctx);
}
async function page(ctx: QueryCtx, projectId: Id<'hostedProjects'>, digest: string) {
  let seen = requests.get(ctx);
  if (!seen) requests.set(ctx, (seen = []));
  const cached = seen.find(row => row.projectId === projectId && row.first <= digest && digest <= row.last);
  if (cached) return cached;
  const [found] = await ctx.db
    .query('projectObjectCatalog')
    .withIndex('by_project_and_first', q => q.eq('projectId', projectId).lte('first', digest))
    .order('desc')
    .take(1);
  if (!found || found.last < digest) return null;
  seen.push(found);
  return found;
}
/** A purged object's row stays as its tombstone (Item 9d3c407d): every read through this lookup,
 * whatever its route (checkout, diff, show, Git, compose), refuses with the same PURGED reply. The
 * row is already read, so this costs nothing. Maintenance that must see it queries the index directly. */
function refusePurged(row: Doc<'projectObjects'> | null) {
  if (row?.purged)
    throw new ForgeError('PURGED', purgedMessage(row.purged), undefined, {
      purged: { at: row.purged.at, operationId: row.purged.operationId },
    });
}
/** The only digest lookup for project objects (guarded by tests/object-catalog.test.mjs):
 * a per-object row first, then the sorted catalog written by GitHub import. */
export async function findObject(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  digest: string,
): Promise<ObjectView | null> {
  const row = await ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
    .unique();
  refusePurged(row);
  if (row || !digestPattern.test(digest)) return row;
  return (await findSourceObjects(ctx, projectId, [digest])).get(digest) ?? null;
}
/** findObject for a page: per-object rows are read concurrently (one point read per
 * distinct digest), then catalog misses resolve in sorted order through the request
 * cache, so each catalog row is still read at most once. Serial reads cost ~3 ms each. */
export async function findObjects(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  digests: readonly string[],
): Promise<(ObjectView | null)[]> {
  const unique = [...new Set(digests)];
  const rows = await Promise.all(
    unique.map(digest =>
      ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
        .unique(),
    ),
  );
  for (const row of rows) refusePurged(row);
  const found = new Map<string, ObjectView | null>(unique.map((digest, i) => [digest, rows[i] ?? null]));
  const missing = unique.filter(digest => !found.get(digest) && digestPattern.test(digest));
  for (const [digest, object] of await findSourceObjects(ctx, projectId, missing)) found.set(digest, object);
  return digests.map(digest => found.get(digest) ?? null);
}
/** Immutable authority behind mutable/pending rows. Retry receipts and cleanup
 * can consult the original stored binding without replacing current row authority. */
export async function findSourceObjects(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  digests: readonly string[],
) {
  const unique = [...new Set(digests)].filter(digest => digestPattern.test(digest));
  const found = await findPointObjects(ctx, projectId, unique);
  if (!unique.length || (await pointMode(ctx, projectId)) === 2) return found;
  for (const digest of unique.filter(digest => !found.has(digest)).sort()) {
    const row = await page(ctx, projectId, digest),
      object = row && entry(row, digest);
    if (object) found.set(digest, object);
  }
  return found;
}
/** Content reads may use an already committed immutable binding while another
 * raw/pack upload of that hash is still pending. Upload preparation/commit keep
 * the primary row and original ID; trusted State metadata stays on that row. */
export async function findStoredObjects(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  digests: readonly string[],
) {
  const rows = await findObjects(ctx, projectId, digests);
  const pending = rows.flatMap(row => (row && !row.removed && !isStored(row) ? [row.digest] : []));
  if (!pending.length) return rows;
  const fallback = await findSourceObjects(ctx, projectId, pending);
  return rows.map(row => {
    if (!row || row.removed || isStored(row)) return row;
    const stored = fallback.get(row.digest);
    if (!stored || stored.size !== row.size) return row;
    return {
      ...stored,
      ...(row.stateGeneration === undefined ? {} : { stateGeneration: row.stateGeneration }),
      ...(row.stateSize === undefined ? {} : { stateSize: row.stateSize }),
      ...(row.stateParents === undefined ? {} : { stateParents: row.stateParents }),
      ...(row.statePhysical === undefined ? {} : { statePhysical: row.statePhysical }),
      ...(row.recipeClosure === undefined ? {} : { recipeClosure: row.recipeClosure }),
    };
  });
}
export async function findStoredObject(ctx: QueryCtx, projectId: Id<'hostedProjects'>, digest: string) {
  return (await findStoredObjects(ctx, projectId, [digest]))[0] ?? null;
}
/** Writers that must return or patch a row id: a catalog entry is copied into an
 * equivalent stored row (rare: catalog objects are already stored). */
export async function objectRow(ctx: MutationCtx, object: ObjectView): Promise<Doc<'projectObjects'>> {
  if (object._id !== undefined) return object;
  const fields = { ...object };
  delete fields._id;
  delete fields._creationTime;
  const id = await ctx.db.insert('projectObjects', { ...fields, nonce: object.nonce || crypto.randomUUID() });
  return (await ctx.db.get(id))!;
}
// One indexed read per request and project, only where a physical binding is handed out.
const purgedProjects = new WeakMap<QueryCtx, Map<string, Promise<boolean>>>();
/** A State's physical manifest maps file digests straight to stored bytes, past this lookup. Once a
 * project has an owner save purge (Item 9d3c407d), reads drop that shortcut and take the catalog
 * path, where every blob goes through findObjects and a purged one refuses PURGED. */
export async function readablePhysical(ctx: QueryCtx, row: Pick<ObjectView, 'projectId' | 'statePhysical'>) {
  if (!row.statePhysical) return undefined;
  let projects = purgedProjects.get(ctx);
  if (!projects) purgedProjects.set(ctx, (projects = new Map()));
  let purged = projects.get(row.projectId);
  if (!purged)
    projects.set(
      row.projectId,
      (purged = ctx.db
        .query('projectSavePurges')
        .withIndex('by_project_and_state', q => q.eq('projectId', row.projectId))
        .take(1)
        .then(found => found.length > 0)),
    );
  return (await purged) ? undefined : row.statePhysical;
}
/** The owner save purge's target (Item 9d3c407d): the object's own row even when already purged
 * (the one reader that must see a tombstone), a catalog entry copied into a row, or null. */
export async function purgeTargetRow(ctx: MutationCtx, projectId: Id<'hostedProjects'>, digest: string) {
  const row = await ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
    .unique();
  if (row) return row;
  const source = (await findSourceObjects(ctx, projectId, [digest])).get(digest);
  return source ? objectRow(ctx, source) : null;
}
type CatalogPageEntry = {
  digest: string;
  size: number;
  stateGeneration?: number;
  stateSize?: StateSize;
  recipe?: { digest: string; size: number };
  pack?: ObjectPack;
};
/** Sorted catalog rows for a set of stored objects; callers write them once. */
export function catalogPages(objects: CatalogPageEntry[], pageSize = objectCatalogPage) {
  return [
    ...sortedCatalogPages(
      [...objects].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)),
      pageSize,
    ),
  ];
}
/** The same rows for objects already in ascending digest order, made one page at a time
 * so a caller never holds a second copy of the whole catalog. */
export function* sortedCatalogPages(sorted: Iterable<CatalogPageEntry>, pageSize = objectCatalogPage) {
  let rows: CatalogPageEntry[] = [];
  const page = () => ({
    first: rows[0]!.digest,
    last: rows.at(-1)!.digest,
    digests: rows.map(row => row.digest).join(''),
    sizes: rows.map(row => row.size),
    ...(rows.some(row => row.stateGeneration !== undefined)
      ? {
          stateGenerations: rows.flatMap((row, index) =>
            row.stateGeneration === undefined ? [] : [{ index, generation: row.stateGeneration }],
          ),
        }
      : {}),
    ...(rows.some(row => row.stateSize !== undefined)
      ? { stateSizes: rows.flatMap((row, index) => (row.stateSize ? [{ index, ...row.stateSize }] : [])) }
      : {}),
    recipes: rows.flatMap((row, index) => (row.recipe ? [{ index, ...row.recipe }] : [])),
    ...(rows.some(row => row.pack)
      ? { packs: rows.flatMap((row, index) => (row.pack ? [{ index, ...row.pack }] : [])) }
      : {}),
  });
  for (const row of sorted) {
    rows.push(row);
    if (rows.length < pageSize) continue;
    yield page();
    rows = [];
  }
  if (rows.length) yield page();
}
