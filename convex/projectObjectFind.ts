// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { r2Key } from './r2';

/** Objects per catalog row (~19 KB): a lookup reads one small document. */
export const objectCatalogPage = 256;
/** A catalog entry: stored, immutable, no row (`_id` undefined). */
export type CatalogObject = Omit<Doc<'projectObjects'>, '_id' | '_creationTime'> & {
  _id?: undefined;
  _creationTime?: undefined;
};
/** A stored object: its own row, or a catalog entry. */
export type ObjectView = Doc<'projectObjects'> | CatalogObject;
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
      return {
        projectId: page.projectId,
        digest,
        size: page.sizes[middle]!,
        nonce: '',
        removed: false,
        sourceReferenced: true,
        ...(recipe
          ? { recipe: { digest: recipe.digest, size: recipe.size } }
          : { location: 'r2' as const, r2Key: r2Key(page.projectId, digest), r2Committed: true }),
      };
    }
    if (found < digest) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}
// Function contexts are request-local and catalog rows are immutable, so one
// request reads each catalog row at most once however many digests it resolves.
const requests = new WeakMap<QueryCtx, Page[]>();
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
  if (row || !digestPattern.test(digest)) return row;
  const found = await page(ctx, projectId, digest);
  return found && entry(found, digest);
}
/** Writers that must return or patch a row id: a catalog entry is copied into an
 * equivalent stored row (rare: catalog objects are already stored). */
export async function objectRow(ctx: MutationCtx, object: ObjectView): Promise<Doc<'projectObjects'>> {
  if (object._id !== undefined) return object;
  const id = await ctx.db.insert('projectObjects', {
    projectId: object.projectId,
    digest: object.digest,
    size: object.size,
    nonce: crypto.randomUUID(),
    removed: false,
    sourceReferenced: true,
    ...(object.recipe
      ? { recipe: object.recipe }
      : { location: 'r2' as const, r2Key: object.r2Key, r2Committed: true }),
  });
  return (await ctx.db.get(id))!;
}
/** Sorted catalog rows for a set of stored objects; callers write them once. */
export function catalogPages(
  objects: { digest: string; size: number; recipe?: { digest: string; size: number } }[],
) {
  const sorted = [...objects].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const pages = [];
  for (let start = 0; start < sorted.length; start += objectCatalogPage) {
    const rows = sorted.slice(start, start + objectCatalogPage);
    pages.push({
      first: rows[0]!.digest,
      last: rows.at(-1)!.digest,
      digests: rows.map(row => row.digest).join(''),
      sizes: rows.map(row => row.size),
      recipes: rows.flatMap((row, index) => (row.recipe ? [{ index, ...row.recipe }] : [])),
    });
  }
  return pages;
}
