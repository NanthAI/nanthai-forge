// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { readJob } from './projectGithubImportRead';
import { inventory, jobIdentity, retain } from './projectGithubImportInventory';
import { objectCatalogPage } from './projectObjectFind';
import { importPageFiles } from '../src/github-import-pages';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { purgePageBudget, documentBytes } from './projectPurgeBudget';
import { stateSize, stateSizes, objectPack } from './projectObjectFields';
import { validStateSize, type StateSize } from '../src/state/size';
import type { ObjectPack } from '../src/object-pack-range';

export const catalogEntry = v.object({
  digest: v.string(),
  size: v.number(),
  stateGeneration: v.optional(v.number()),
  stateSize: v.optional(stateSize),
  recipe: v.optional(v.object({ digest: v.string(), size: v.number() })),
  pack: v.optional(objectPack),
});
type Entry = {
  digest: string;
  size: number;
  stateGeneration?: number;
  stateSize?: StateSize;
  recipe?: { digest: string; size: number };
  pack?: ObjectPack;
};
const catalogRow = v.object({
  first: v.string(),
  last: v.string(),
  digests: v.string(),
  sizes: v.array(v.number()),
  stateSizes,
  stateGenerations: v.optional(v.array(v.object({ index: v.number(), generation: v.number() }))),
  recipes: v.array(v.object({ index: v.number(), digest: v.string(), size: v.number() })),
  packs: v.optional(
    v.array(v.object({ index: v.number(), digest: v.string(), size: v.number(), offset: v.number() })),
  ),
});
const pin = /^[0-9a-f]{64}$/;
/** Field order is not identity: a stored row and a rebuilt page compare by sorted keys. */
const same = (a: unknown, b: unknown) => canonicalPayload(a ?? []) === canonicalPayload(b ?? []);
const validEntry = (entry: Entry) =>
  pin.test(entry.digest) &&
  Number.isSafeInteger(entry.size) &&
  entry.size >= 0 &&
  (entry.stateGeneration === undefined ||
    (Number.isSafeInteger(entry.stateGeneration) && entry.stateGeneration > 0)) &&
  (entry.stateSize === undefined ||
    (validStateSize(entry.stateSize) && entry.stateSize.manifestBytes === entry.size)) &&
  (!entry.recipe || (pin.test(entry.recipe.digest) && Number.isSafeInteger(entry.recipe.size))) &&
  (!entry.pack ||
    (!entry.recipe &&
      pin.test(entry.pack.digest) &&
      Number.isSafeInteger(entry.pack.size) &&
      Number.isSafeInteger(entry.pack.offset) &&
      entry.pack.offset >= 0 &&
      entry.size > 0 &&
      Number.isSafeInteger(entry.pack.offset + entry.size) &&
      entry.pack.offset + entry.size <= entry.pack.size));

/** One inventory row per stored upload window (archive imports): the
 * continuation skip set until publication writes the sorted catalog. */
export async function recordWindow(ctx: MutationCtx, job: Doc<'projectGithubImports'>, objects: Entry[]) {
  if (!objects.length) return;
  invariant(
    objects.length <= 2 * importPageFiles + 1 && objects.every(validEntry),
    'IMPORT_PAGE_CHANGED',
    'Record verified object pins in bounded windows.',
  );
  const value = JSON.stringify({
    digests: objects.map(entry => entry.digest).join(''),
    sizes: objects.map(entry => entry.size),
    ...(objects.some(entry => entry.stateGeneration !== undefined)
      ? {
          stateGenerations: objects.flatMap((entry, index) =>
            entry.stateGeneration === undefined ? [] : [{ index, generation: entry.stateGeneration }],
          ),
        }
      : {}),
    ...(objects.some(entry => entry.stateSize !== undefined)
      ? {
          stateSizes: objects.flatMap((entry, index) =>
            entry.stateSize ? [{ index, ...entry.stateSize }] : [],
          ),
        }
      : {}),
    recipes: objects.flatMap((entry, index) => (entry.recipe ? [{ index, ...entry.recipe }] : [])),
    packs: objects.flatMap((entry, index) => (entry.pack ? [{ index, ...entry.pack }] : [])),
  });
  await retain(ctx, job, [{ part: 'objects', key: digest(value), position: 0, value }]);
}
export function windowEntries(value: string): Entry[] {
  const row: {
    digests: string;
    sizes: number[];
    stateSizes?: ({ index: number } & StateSize)[];
    stateGenerations?: { index: number; generation: number }[];
    recipes: { index: number; digest: string; size: number }[];
    packs?: ({ index: number } & ObjectPack)[];
  } = JSON.parse(value);
  const entries: Entry[] = row.sizes.map((size, index) => ({
    digest: row.digests.slice(index * 64, index * 64 + 64),
    size,
  }));
  for (const { index, generation } of row.stateGenerations ?? [])
    entries[index]!.stateGeneration = generation;
  for (const { index, fileCount, manifestBytes } of row.stateSizes ?? [])
    entries[index]!.stateSize = { fileCount, manifestBytes };
  for (const { index, digest, size } of row.recipes) entries[index]!.recipe = { digest, size };
  for (const { index, digest, size, offset } of row.packs ?? [])
    entries[index]!.pack = { digest, size, offset };
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
          (page.stateSizes ?? []).every(
            row =>
              Number.isSafeInteger(row.index) &&
              row.index >= 0 &&
              row.index < count &&
              validStateSize(row) &&
              row.manifestBytes === page.sizes[row.index],
          ) &&
          new Set((page.stateSizes ?? []).map(row => row.index)).size === (page.stateSizes?.length ?? 0) &&
          page.recipes.every(row => row.index >= 0 && row.index < count) &&
          (page.packs ?? []).every(
            row => Number.isSafeInteger(row.index) && row.index >= 0 && row.index < count,
          ) &&
          (page.stateGenerations ?? []).every(
            row => Number.isSafeInteger(row.index) && row.index >= 0 && row.index < count,
          ) &&
          new Set((page.stateGenerations ?? []).map(row => row.index)).size ===
            (page.stateGenerations?.length ?? 0) &&
          new Set((page.packs ?? []).map(row => row.index)).size === (page.packs?.length ?? 0),
        'IMPORT_PAGE_CHANGED',
        'Catalog rows are malformed.',
      );
      for (let index = 0; index < count; index++) {
        const entry = page.digests.slice(index * 64, index * 64 + 64);
        invariant(
          validEntry({
            digest: entry,
            size: page.sizes[index]!,
            ...(page.stateGenerations?.some(row => row.index === index)
              ? { stateGeneration: page.stateGenerations.find(row => row.index === index)!.generation }
              : {}),
            recipe: page.recipes.find(row => row.index === index),
            pack: page.packs?.find(row => row.index === index),
          }) &&
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
          previous.digests === page.digests &&
            previous.last === page.last &&
            same(previous.sizes, page.sizes) &&
            same(previous.recipes, page.recipes) &&
            same(previous.packs, page.packs) &&
            same(previous.stateGenerations, page.stateGenerations) &&
            same(previous.stateSizes, page.stateSizes),
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
/** Import progress rows are transient: deleted once main is published. A page is
 * bounded by bytes read, not by a row count (a window row is about 135 KB at 1,000
 * objects): rows stream in key order and the page stops after 4 MiB or 1,000 rows, so
 * it reads under 8 MiB however large the repository is, then continues itself. */
export async function purgeInventory(ctx: MutationCtx, jobId: Id<'projectGithubImports'>, actor: string) {
  let rows = 0,
    bytes = 0;
  const query = ctx.db
    .query('projectGithubImportInventory')
    .withIndex('by_job_and_part_and_key', q => q.eq('jobId', jobId));
  for await (const row of query) {
    if (rows >= purgePageBudget.rows || bytes >= purgePageBudget.bytes) {
      await ctx.scheduler.runAfter(0, internal.projectGithubImportCatalog.purge, { id: jobId, actor });
      return;
    }
    rows++;
    bytes += documentBytes(row);
    await ctx.db.delete(row._id);
  }
}
export const purge = internalMutation({
  args: jobIdentity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await ctx.db.get(input.id);
    if (job?.phase === 'ready') await purgeInventory(ctx, job._id, input.actor);
    return null;
  },
});
