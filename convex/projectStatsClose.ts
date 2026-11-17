// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Stats day close (Item a61d3c91): called from the landing's speed record with the previous newest
 * landing's time, so it reads nothing. It schedules one close when the UTC day changed since that landing:
 * one scheduled mutation per active project-day, none for an idle project. */
export async function scheduleStatsClose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  previousAt: number | undefined,
  at: number,
) {
  if (previousAt === undefined || !Number.isFinite(previousAt) || utcDay(previousAt) >= utcDay(at)) return;
  await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
    projectId,
    day: utcDay(previousAt),
  });
}
