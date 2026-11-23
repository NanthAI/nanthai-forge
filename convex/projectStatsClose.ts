// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { hostedPipelineWidth } from '../src/hosted-landing-batch';

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const HOUR_MS = 3_600_000;
/** The UTC hour a time falls in (ms / one hour). */
export const utcHour = (ms: number) => Math.floor(ms / HOUR_MS);
/** Today so far runs this long after the hour it counts ends, so that hour's last landings have committed. */
export const STATS_HOUR_SLACK_MS = 5_000;

/** Stats day close (Item a61d3c91): called from the landing's speed record with the previous newest
 * landing's time, so it reads nothing. It schedules one close when the UTC day changed since that landing:
 * one scheduled mutation per active project-day, none for an idle project. The first landing of each later UTC hour
 * (a new day's too) schedules today so far for the end of that hour (Item 8d21cc9e): Stats' open day then counts
 * every landing up to the last full hour, first and last active hours included, whether or not anyone opens Stats.
 * One scheduled close per active project-hour, none idle; a new day's runs after the previous day's close. */
export async function scheduleStatsClose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  previousAt: number | undefined,
  at: number,
) {
  if (previousAt === undefined || !Number.isFinite(previousAt)) return;
  if (utcDay(previousAt) < utcDay(at))
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
      projectId,
      day: utcDay(previousAt),
    });
  if (utcHour(previousAt) < utcHour(at))
    await ctx.scheduler.runAfter(
      Math.max(0, (utcHour(at) + 1) * HOUR_MS + STATS_HOUR_SLACK_MS - Date.now()),
      makeFunctionReference<'mutation'>('projectStats:closeDay'),
      { projectId, day: utcDay(at), provisional: true },
    );
}

/** The merge-queue width a day's replay uses: the project's own `checks.concurrency` now (the pipeline width the
 * landing queue runs, default 6), so the replayed GitHub queue builds as many entries at once as Forge's does. One
 * project row and at most one policy receipt, read once per close: 2 small reads, the same at 100 and at 1,000 landings
 * a day. A project-day closes at most 25 times (24 hourly so-far closes and the final one): at most 50 reads a day,
 * none per landing, none per view, none at idle. */
export async function statsQueueWidth(ctx: Pick<MutationCtx, 'db'>, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  if (!project) return undefined;
  const latest = await ctx.db
    .query('projectPolicyChanges')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .order('desc')
    .first();
  // A plan-visibility row carries the default policy on a project that never stored one; it is not a receipt.
  const receipt = latest?.planChange && !project.autonomyPolicy ? undefined : latest?.policy;
  return hostedPipelineWidth(receipt ?? effectivePolicy(project));
}
