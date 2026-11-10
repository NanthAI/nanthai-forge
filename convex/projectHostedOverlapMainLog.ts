// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  DRIFT_NUDGE_MIN_LANDINGS,
  DRIFT_NUDGE_NAMES,
  landingsFromLabels,
  mergeLandingLogs,
  overlapMainFromLog,
  type OverlapMain,
} from '../src/hosted-overlap';

/** Main path touches per landing (Issue 750c5929). The whole main row holds every path main touched,
 * up to 128 KB (140 KB on Forge), and the save-time trial merge, the overlap read and the landing
 * completion each read it in full, although a Lane a few landings behind needs only those landings.
 * This log keeps one small row per landing for the newest MAIN_LOG_WINDOW landings; readers take the
 * range after the Lane's base and read the whole row only when the log cannot answer exactly. */
export const MAIN_LOG_WINDOW = 64;
/** A landing touching more paths than fit here is logged with unknown paths (readers fall back). */
const MAIN_LOG_PATH_BYTES = 4096;

const log = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedOverlapMainLog')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId));

/** Written in the acceptance transaction beside the main row (`after` is that row's sequence before
 * it moved). One insert of ~0.3 KB and at most two deletes of rows that left the window. */
export async function appendOverlapMainLog(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  after: number,
  sequence: number,
  paths: string[] | null,
) {
  const text = paths === null ? null : JSON.stringify([...new Set(paths)].sort());
  await ctx.db.insert('projectHostedOverlapMainLog', {
    projectId,
    sequence,
    after,
    paths: text !== null && new TextEncoder().encode(text).length <= MAIN_LOG_PATH_BYTES ? text : null,
  });
  const expired = await ctx.db
    .query('projectHostedOverlapMainLog')
    .withIndex('by_project_and_sequence', q =>
      q.eq('projectId', projectId).lte('sequence', sequence - MAIN_LOG_WINDOW),
    )
    .take(2);
  for (const row of expired) await ctx.db.delete(row._id);
}

/** The landing's drift-nudge name on its log row; false when the landing has no row (logged before
 * this table existed), so the caller keeps the main row's own landing log. The name is built only
 * when there is a row to put it on (it costs account reads). Idempotent. */
export async function labelOverlapMainLog(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  sequence: number,
  label: () => Promise<string>,
) {
  const row = await ctx.db
    .query('projectHostedOverlapMainLog')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).eq('sequence', sequence))
    .unique();
  if (!row) return false;
  const text = await label();
  if (row.label !== text) await ctx.db.patch(row._id, { label: text });
  return true;
}

/** Main's path touches after `base` as the main row's view, from the log: null when the log cannot
 * answer exactly (more than MAIN_LOG_WINDOW landings behind, a log that starts after the base, or a
 * landing with unknown paths); the caller then reads the whole main row, as before. */
export async function overlapMainSince(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  base: number,
): Promise<OverlapMain | null> {
  const after = await ctx.db
    .query('projectHostedOverlapMainLog')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).gt('sequence', base))
    .take(MAIN_LOG_WINDOW + 1);
  if (after.length > MAIN_LOG_WINDOW) return null;
  if (!after.length) {
    // Nothing logged after the base: the newest row says the log is current (it is written with the
    // main row, so it is never behind it).
    const [newest] = await log(ctx, projectId).order('desc').take(1);
    return newest ? overlapMainFromLog([], base, newest.sequence) : null;
  }
  if (after[0]!.after > base) return null;
  for (let i = 0; i < after.length; i++)
    if (after[i]!.paths === null || (i > 0 && after[i]!.after !== after[i - 1]!.sequence)) return null;
  return overlapMainFromLog(
    after as { sequence: number; paths: string; label?: string }[],
    base,
    after.at(-1)!.sequence,
  );
}

/** Drift-nudge names for these landings from their log rows (one point read each). */
export async function overlapLandingLabels(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  sequences: number[],
) {
  const rows = [];
  for (const sequence of sequences) {
    const row = await ctx.db
      .query('projectHostedOverlapMainLog')
      .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).eq('sequence', sequence))
      .unique();
    if (row) rows.push(row);
  }
  return rows;
}

/** The main row's view for the overlap read of a Lane based at `base` that saved `paths`: the log
 * after the base, else the whole main row. The whole row's own landing log stopped growing when the
 * log began, so a drift nudge it would raise takes the names of its newest landings from their log
 * rows (at most DRIFT_NUDGE_NAMES point reads, only when the nudge applies). */
export async function overlapMainFor(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  base: number | null,
  paths: ReadonlySet<string>,
) {
  const fromLog = base === null ? null : await overlapMainSince(ctx, projectId, base);
  if (fromLog) return fromLog;
  const main = await ctx.db
    .query('projectHostedOverlapMain')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!main || base === null) return main;
  const sequences = new Set<number>();
  for (const [path, sequence] of JSON.parse(main.changes) as [string, number][])
    if (sequence > base && paths.has(path)) sequences.add(sequence);
  if (sequences.size < DRIFT_NUDGE_MIN_LANDINGS) return main;
  const named = [...sequences].sort((a, b) => b - a).slice(0, DRIFT_NUDGE_NAMES);
  const landings = mergeLandingLogs(
    main.landings,
    landingsFromLabels(await overlapLandingLabels(ctx, projectId, named)),
  );
  return { ...main, ...(landings ? { landings } : {}) };
}
