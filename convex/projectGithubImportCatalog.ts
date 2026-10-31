// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { readJob } from './projectGithubImportRead';
import { inventory, jobIdentity, retain } from './projectGithubImportInventory';
import { objectCatalogPage } from './projectObjectFind';
import { importPageFiles } from '../src/github-import-pages';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';

export const catalogEntry = v.object({
  digest: v.string(),
  size: v.number(),
  recipe: v.optional(v.object({ digest: v.string(), size: v.number() })),
});
type Entry = { digest: string; size: number; recipe?: { digest: string; size: number } };
const catalogRow = v.object({
  first: v.string(),
  last: v.string(),
  digests: v.string(),
  sizes: v.array(v.number()),
  recipes: v.array(v.object({ index: v.number(), digest: v.string(), size: v.number() })),
});
const pin = /^[0-9a-f]{64}$/;
const validEntry = (entry: Entry) =>
  pin.test(entry.digest) &&
  Number.isSafeInteger(entry.size) &&
  entry.size >= 0 &&
  (!entry.recipe || (pin.test(entry.recipe.digest) && Number.isSafeInteger(entry.recipe.size)));

/** One inventory row per stored upload window (archive imports): the
 * continuation skip set until publication writes the sorted catalog. */
export async function recordWindow(ctx: MutationCtx, job: Doc<'projectGithubImports'>, objects: Entry[]) {
  if (!objects.length) return;
  invariant(
    objects.length <= 2 * importPageFiles && objects.every(validEntry),
    'IMPORT_PAGE_CHANGED',
    'Record verified object pins in bounded windows.',
  );
  const value = JSON.stringify({
    digests: objects.map(entry => entry.digest).join(''),
    sizes: objects.map(entry => entry.size),
    recipes: objects.flatMap((entry, index) => (entry.recipe ? [{ index, ...entry.recipe }] : [])),
  });
  await retain(ctx, job, [{ part: 'objects', key: digest(value), position: 0, value }]);
}
export function windowEntries(value: string): Entry[] {
  const row: {
    digests: string;
    sizes: number[];
    recipes: { index: number; digest: string; size: number }[];
  } = JSON.parse(value);
  const entries: Entry[] = row.sizes.map((size, index) => ({
    digest: row.digests.slice(index * 64, index * 64 + 64),
    size,
  }));
  for (const { index, digest, size } of row.recipes) entries[index]!.recipe = { digest, size };
  return entries;
}
/** Stored windows in bounded pages (a continuation reads them once per run). */
export const stored = internalQuery({
  args: { ...jobIdentity, after: v.string() },
  returns: v.array(v.object({ key: v.string(), value: v.string() })),
  handler: async (ctx, input) => {
    await readJob(ctx, input);
    return (await inventory(ctx, input.id, 'objects', input.after)).map(({ key, value }) => ({ key, value }));
  },
});
/** Immutable sorted catalog rows; a replay finds the same rows and writes nothing. */
export const publish = internalMutation({
  args: { ...jobIdentity, step: v.number(), pages: v.array(catalogRow) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input);
    invariant(
      job.protocol === 3 && job.step === input.step && job.phase !== 'ready' && input.pages.length <= 64,
      'IMPORT_PAGE_CHANGED',
      'Publish the catalog of the current archive import in bounded pages.',
    );
    for (const page of input.pages) {
      const count = page.sizes.length;
      invariant(
        count > 0 &&
          count <= objectCatalogPage &&
          page.digests.length === count * 64 &&
          page.first === page.digests.slice(0, 64) &&
          page.last === page.digests.slice(-64) &&
          page.recipes.every(row => row.index >= 0 && row.index < count),
        'IMPORT_PAGE_CHANGED',
        'Catalog rows are malformed.',
      );
      for (let index = 0; index < count; index++) {
        const entry = page.digests.slice(index * 64, index * 64 + 64);
        invariant(
          validEntry({ digest: entry, size: page.sizes[index]! }) &&
            (index === 0 || page.digests.slice(index * 64 - 64, index * 64) < entry),
          'IMPORT_PAGE_CHANGED',
          'Catalog rows must be sorted verified pins.',
        );
      }
      const [previous] = await ctx.db
        .query('projectObjectCatalog')
        .withIndex('by_project_and_first', q => q.eq('projectId', job.projectId).eq('first', page.first))
        .take(1);
      if (previous) {
        invariant(
          previous.digests === page.digests && previous.last === page.last,
          'IMPORT_PAGE_CHANGED',
          'Immutable catalog changed.',
        );
        continue;
      }
      await ctx.db.insert('projectObjectCatalog', {
        projectId: job.projectId,
        ...page,
        origin: `github-import:${job._id}`,
      });
    }
    return null;
  },
});
/** Import progress rows are transient: deleted once main is published. */
export async function purgeInventory(ctx: MutationCtx, jobId: Id<'projectGithubImports'>, actor: string) {
  const rows = await ctx.db
    .query('projectGithubImportInventory')
    .withIndex('by_job_and_part_and_key', q => q.eq('jobId', jobId))
    .take(inventoryPurgePage);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === inventoryPurgePage)
    await ctx.scheduler.runAfter(0, internal.projectGithubImportCatalog.purge, { id: jobId, actor });
}
export const inventoryPurgePage = 500;
export const purge = internalMutation({
  args: jobIdentity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.id);
    if (job?.phase === 'ready') await purgeInventory(ctx, job._id, input.actor);
    return null;
  },
});
