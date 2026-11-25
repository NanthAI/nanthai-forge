// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off delete (Item c0af6cfa, F5 leftover). Not part of the product: it lives in the pinned in-between
// release, runs once per deployment and is deleted with its last proof (docs/operations/legacy-work-layout.md).
import { v } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import { internal } from './_generated/api';
import { internalAction, internalMutation } from './server';
import { invariant } from '../src/errors';

/** The operator names the deployment it means to change (dev with its name, prod only with the owner's go).
 * The name is the subdomain of the deployment this code runs on; a mismatch refuses before any read. */
export const confirmed = (deployment: string) =>
  invariant(
    new URL(process.env.CONVEX_CLOUD_URL ?? 'https://unset.invalid').hostname.split('.')[0] === deployment,
    'PROJECT_UNAVAILABLE',
    'The deployment argument does not name the deployment this code runs on.',
  );
export const MIB = 1024 * 1024;
export const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value)).length;
/** One page reads at most this many bytes, plus the one document that can end its last read past the cap
 * (a Convex document is at most 1 MiB). The action starts a page only when both fit in what is left. */
export const PAGE_BYTES = 4 * MIB;
export const PAGE_RESERVE = PAGE_BYTES + MIB;

/** The bytes one page may still read. Every read is capped by `left` and charged to it, so the page stops
 * before it can pass its allowance instead of counting afterwards. */
export type Meter = { left: number; used: number };
export const meter = (): Meter => ({ left: PAGE_BYTES, used: 0 });
type Paginate<T> = (options: PaginationOptions) => Promise<PaginationResult<T>>;
/** Read up to `rows` rows, stopping at the bytes the page has left; with none left it reads nothing.
 * `complete` is false when the cap cut the read short, so the caller must stop the page rather than treat the
 * rows as everything. */
export async function bounded<T extends object>(
  page: Meter,
  paginate: Paginate<T>,
  rows: number,
  cursor: string | null = null,
) {
  if (page.left <= 0)
    return { rows: [] as T[], complete: false, result: { page: [], isDone: false, continueCursor: '' } };
  const result = await paginate({
    cursor,
    numItems: rows,
    maximumRowsRead: rows,
    maximumBytesRead: Math.max(page.left, 1),
  } as PaginationOptions);
  const size = result.page.reduce((sum, row) => sum + bytes(row), 0);
  page.left -= size;
  page.used += size;
  return { rows: result.page, complete: result.isDone || result.page.length >= rows, result };
}

/** The partition layout marker, and the progress row a copy wrote while it ran. Both are unread now. */
const collections = ['_workStoreLayout', '_workStoreLayoutProgress'] as const;

/** One project of the census: its record partitions (a generation that shares another's records names that
 * partition), one marker lookup per collection. Only a `moved` marker is deleted: any other layout means the
 * conversion is unfinished and stays listed in `blocked`. `apply:false` only counts. Every read is capped by
 * the page's remaining bytes; a project that does not fit stops the page with `incomplete` and is read again
 * from its own cursor (every delete already made is gone, so the rerun counts it as 0). */
export const markerRowsPage = internalMutation({
  args: { deployment: v.string(), cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.any(),
  handler: async (ctx, { deployment, cursor, apply }) => {
    confirmed(deployment);
    const page = meter();
    const counts = { projects: 0, partitions: 0, found: 0, deleted: 0 };
    const blocked: string[] = [];
    const stop = () => ({ counts, readBytes: page.used, blocked, next: cursor, incomplete: true });
    const census = await bounded(
      page,
      options => ctx.db.query('hostedProjects').paginate(options),
      1,
      cursor,
    );
    if (!census.complete) return stop();
    const [project] = census.rows;
    if (project) {
      const generations = await bounded(
        page,
        options =>
          ctx.db
            .query('projectWorkGenerations')
            .withIndex('by_project_and_backup_and_revision_and_format', q => q.eq('projectId', project._id))
            .paginate(options),
        65,
      );
      invariant(
        generations.rows.length <= 64,
        'WORK_STALE',
        'A project keeps more than 64 Work index generations.',
      );
      if (!generations.complete) return stop();
      counts.projects++;
      const partitions = new Set(
        generations.rows.map(generation => generation.recordsGenerationId ?? generation._id),
      );
      for (const partition of partitions) {
        counts.partitions++;
        for (const collection of collections) {
          const found = await bounded(
            page,
            options =>
              ctx.db
                .query('projectWorkDataRecords')
                .withIndex('by_generation_and_collection_and_key', q =>
                  q.eq('generationId', partition).eq('collection', collection),
                )
                .paginate(options),
            4,
          );
          if (!found.complete) return stop();
          for (const row of found.rows) {
            counts.found++;
            const layout =
              collection === '_workStoreLayout'
                ? (JSON.parse(row.value) as { layout?: string }).layout
                : null;
            if (layout !== 'moved') {
              blocked.push(`${partition}:${collection}:${layout ?? 'progress'}`);
              continue;
            }
            if (apply) await ctx.db.delete(row._id);
            counts.deleted++;
          }
        }
      }
    }
    return {
      counts,
      readBytes: page.used,
      blocked,
      next: census.result.isDone ? null : census.result.continueCursor,
      incomplete: false,
    };
  },
});

/** Drive every project within one stated read budget. A replay of an applied run prints `found: 0`. A stop
 * says why: `budget` (no room for another page), `page` (one project needs more than a page's allowance),
 * `over` (the reads passed the budget). */
export const markerRowsRun = internalAction({
  args: { deployment: v.string(), apply: v.boolean(), budgetBytes: v.number() },
  returns: v.any(),
  handler: async (ctx, { deployment, apply, budgetBytes }) => {
    confirmed(deployment);
    const totals = { projects: 0, partitions: 0, found: 0, deleted: 0 };
    const blocked: string[] = [];
    let readBytes = 0;
    let stopped: string | null = null;
    let cursor: string | null = null;
    do {
      if (readBytes + PAGE_RESERVE > budgetBytes) {
        stopped = 'budget';
        break;
      }
      const result: {
        counts: typeof totals;
        readBytes: number;
        blocked: string[];
        next: string | null;
        incomplete: boolean;
      } = await ctx.runMutation(internal.legacyWorkMarkerRows.markerRowsPage, { deployment, cursor, apply });
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result.counts[key];
      blocked.push(...result.blocked);
      readBytes += result.readBytes;
      if (result.incomplete) {
        stopped = 'page';
        break;
      }
      cursor = result.next;
    } while (cursor !== null);
    if (readBytes > budgetBytes) stopped = 'over';
    return { apply, readBytes, budgetBytes, counts: totals, blocked, stopped };
  },
});
