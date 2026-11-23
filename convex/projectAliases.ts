// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Item eb631a53: a project keeps its PROJECT_ALIASES most recent addresses (`projectSlugs` rows, newest by creation
 * time: the time this project took the address). Its current address is always the newest; the older ones redirect to
 * it. Anything past the newest 10 is released: it answers "not found" and is free again.
 *
 * Trim contract: read the newest 10 (one range), then delete from the oldest end, below the 10th's creation time,
 * TRIM_PAGE rows per run (one range); more continue in a scheduled run of the same size. Recomputed from current rows
 * each run, so it is idempotent and safe to rerun or race with a rename (a rename's own trim keeps the true newest 10).
 *
 * One-time migration (`trimAll`) for histories written before the cap: TRIM_PROJECTS projects per run (one paginate),
 * each trimmed as above, continuing by cursor. Per run at most 1 + 2 x 25 = 51 index ranges and 25 x 100 = 2,500
 * deletes; a project with more left continues in its own `trim` runs. A rerun writes nothing. */
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './server';

export const PROJECT_ALIASES = 10;
const TRIM_PAGE = 100;
const TRIM_PROJECTS = 25;

/** Releases up to TRIM_PAGE aliases past the newest PROJECT_ALIASES, oldest first; true when more remain. */
async function trimSome(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const newest = await ctx.db
    .query('projectSlugs')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .order('desc')
    .take(PROJECT_ALIASES);
  if (newest.length < PROJECT_ALIASES) return false;
  const cutoff = newest.at(-1)!._creationTime;
  const old = await ctx.db
    .query('projectSlugs')
    .withIndex('by_project', q => q.eq('projectId', projectId).lt('_creationTime', cutoff))
    .take(TRIM_PAGE + 1);
  for (const row of old.slice(0, TRIM_PAGE)) await ctx.db.delete(row._id);
  return old.length > TRIM_PAGE;
}

/** Trim now; schedule the rest. Called after every address claim. */
export async function trimAliases(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  if (await trimSome(ctx, projectId))
    await ctx.scheduler.runAfter(0, internal.projectAliases.trim, { projectId });
}

export const trim = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    await trimAliases(ctx, projectId);
    return null;
  },
});

export const trimAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ projects: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor: cursor ?? null, numItems: TRIM_PROJECTS });
    for (const project of page.page) await trimAliases(ctx, project._id);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.projectAliases.trimAll, { cursor: page.continueCursor });
    return { projects: page.page.length, isDone: page.isDone };
  },
});
