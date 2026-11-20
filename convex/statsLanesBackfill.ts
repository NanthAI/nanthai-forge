// SPDX-License-Identifier: Apache-2.0
// One-time backfill (Item a9ad21c9): before the fix, a day close counted only the Lanes started on its own day, so a
// Lane started on a day with no landing in that project (a weekend, a Lane crossing midnight UTC) was never counted.
// This files those Lanes under their own days. It reads only the gaps between a project's closed days (a closed day's
// own Lanes are already counted) and replaces the Lane fields of the project's entry for each gap day, so a rerun writes
// the same rows. It keeps the planning counts a close wrote there (Items closed, comments, partial marks; Item 6a251b23),
// so it is safe to run at any time, before or after a close; it never writes a Stats day (planningPartial stays).
// Cost: docs/data-placement.md#personDays. Run it by hand, one deployment at a time, with the lead's go.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import { recordPersonDays } from './personDays';
import { DAY_MS, dayStart, lanesByDay } from './statsLanes';
import { statsDaySchema } from '../src/stats-estimate';
import { notMeasured } from '../src/stats-period';

/** Closed-day rows one run looks at. */
export const BACKFILL_DAYS = 40;
/** Documents one run may spend on gap Lanes before it continues in the next run (each gap reads at most two
 * ranges of STATS_LANES_READ, so a run stays well under the 16,384 documents a transaction may read). */
export const BACKFILL_LANE_BUDGET = 6_000;
/** Projects one run hands on. */
export const BACKFILL_PROJECTS = 25;

const ref = (name: string) => makeFunctionReference<'mutation'>(`statsLanesBackfill:${name}`);

/** One project, in order through its closed days: `prev` is the last day row already handled, and `closed` the last
 * closed day before the gap still open (null: none yet, the gap starts at the beginning of time; absent: `prev`). A day
 * left not measured is not a closed day (its close wrote no person days): the gap runs on through it to the next closed
 * day, and a trailing run of them is filed too. The open tail after the last row is the next close's. */
export const project = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    prev: v.optional(v.string()),
    closed: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ gaps: v.number(), lanes: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { projectId, prev, closed }) => {
    const rows = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q =>
        prev === undefined ? q.eq('projectId', projectId) : q.eq('projectId', projectId).gt('day', prev),
      )
      .order('asc')
      .take(BACKFILL_DAYS);
    let spent = 0,
      gaps = 0,
      last = closed === undefined ? prev : (closed ?? undefined),
      seen = prev,
      paused = false;
    const fill = async (to: number) => {
      const from = last === undefined ? 0 : dayStart(last) + DAY_MS;
      if (to <= from) return;
      const lanes = await lanesByDay(ctx, projectId, from, to);
      spent += lanes.read;
      for (const [day, list] of [...lanes.byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
        await recordPersonDays(ctx, projectId, day, list, { lanesOnly: true });
        gaps++;
      }
    };
    for (const row of rows) {
      if (spent >= BACKFILL_LANE_BUDGET) {
        paused = true;
        break;
      }
      seen = row.day;
      if (notMeasured(statsDaySchema.parse(JSON.parse(row.value)))) continue;
      await fill(dayStart(row.day));
      last = row.day;
    }
    const isDone = rows.length < BACKFILL_DAYS && !paused;
    // Days left not measured after the last closed day: their Lanes, up to the end of the newest of them.
    if (isDone && seen !== undefined && seen !== last) await fill(dayStart(seen) + DAY_MS);
    if (!isDone && seen !== undefined)
      await ctx.scheduler.runAfter(0, ref('project'), {
        projectId,
        prev: seen,
        ...(last === seen ? {} : { closed: last ?? null }),
      });
    return { gaps, lanes: spent, isDone };
  },
});

/** Every project, a page at a time, each handed to `project`. Pass nothing to start. */
export const all = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ projects: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_PROJECTS });
    for (const row of page.page)
      if (!row.removal) await ctx.scheduler.runAfter(0, ref('project'), { projectId: row._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, ref('all'), { cursor: page.continueCursor });
    return { projects: page.page.length, isDone: page.isDone };
  },
});
