// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { readJob } from './projectGithubImportRead';
import { githubImportDocument } from './projectGithubImportFields';
import { invariant } from '../src/errors';
import {
  filePage,
  importPageFiles,
  importPageDirectories,
  importPageMetadataBytes,
  type ImportProgress,
} from '../src/github-import-pages';
export const inventoryEntry = v.object({
  part: v.string(),
  key: v.string(),
  position: v.number(),
  value: v.string(),
});
export const jobIdentity = { id: v.id('projectGithubImports'), actor: v.string() };
async function boundedRows(query: AsyncIterable<Doc<'projectGithubImportInventory'>>, count: number) {
  const rows: Doc<'projectGithubImportInventory'>[] = [];
  let bytes = 0;
  for await (const row of query) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length;
    if (rows.length && (rows.length >= count || bytes + size > importPageMetadataBytes)) break;
    rows.push(row);
    bytes += size;
  }
  return rows;
}
export async function inventory(
  ctx: QueryCtx,
  jobId: Id<'projectGithubImports'>,
  part: string,
  after: string,
) {
  return boundedRows(
    ctx.db
      .query('projectGithubImportInventory')
      .withIndex('by_job_and_part_and_key', q => q.eq('jobId', jobId).eq('part', part).gt('key', after)),
    importPageFiles,
  );
}
export async function retain(
  ctx: MutationCtx,
  job: Doc<'projectGithubImports'>,
  entries: { part: string; key: string; position: number; value: string }[],
) {
  invariant(entries.length <= importPageFiles, 'IMPORT_PAGE_CHANGED', 'Split inventory into bounded pages.');
  for (const entry of entries) {
    const previous = await ctx.db
      .query('projectGithubImportInventory')
      .withIndex('by_job_and_part_and_key', q =>
        q.eq('jobId', job._id).eq('part', entry.part).eq('key', entry.key),
      )
      .unique();
    if (previous)
      invariant(
        previous.value === entry.value && previous.position === entry.position,
        'IMPORT_PAGE_CHANGED',
        'Immutable import inventory changed.',
      );
    else
      await ctx.db.insert('projectGithubImportInventory', {
        projectId: job.projectId,
        jobId: job._id,
        ...entry,
      });
  }
}
export const page = internalQuery({
  args: jobIdentity,
  returns: v.object({ job: githubImportDocument, entries: v.array(inventoryEntry) }),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input);
    if (job.protocol !== 2 || job.phase === 'ready') return { job, entries: [] };
    const progress: ImportProgress = JSON.parse(job.cursor);
    const rows = job.totalKnown
      ? await inventory(ctx, job._id, 'files', progress.after)
      : await boundedRows(
          ctx.db
            .query('projectGithubImportInventory')
            .withIndex('by_job_and_part_and_position', q =>
              q
                .eq('jobId', job._id)
                .eq('part', 'directories')
                .gte('position', progress.directories)
                .lt('position', progress.discovered),
            ),
          importPageDirectories,
        );
    const selected = job.totalKnown
      ? filePage(
          rows.map(row => ({ ...row, size: JSON.parse(row.value).size })),
          row => row,
        )
      : rows;
    return {
      job,
      entries: selected.map(({ part, key, position, value }) => ({ part, key, position, value })),
    };
  },
});
export const stage = internalMutation({
  args: { ...jobIdentity, step: v.number(), entries: v.array(inventoryEntry) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input);
    if (job.step === input.step && job.phase !== 'ready') await retain(ctx, job, input.entries);
    return null;
  },
});
export const scan = internalQuery({
  args: { ...jobIdentity, part: v.string(), after: v.string() },
  returns: v.array(inventoryEntry),
  handler: async (ctx, input) => {
    await readJob(ctx, input);
    return (await inventory(ctx, input.id, input.part, input.after)).map(
      ({ part, key, position, value }) => ({ part, key, position, value }),
    );
  },
});
