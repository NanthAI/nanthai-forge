// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { changeLineMark, lineSummary } from './projectLiveLineStore';
import { readFlowLandings, retainedMainVerdict } from './projectLiveLineRecovery';
import { flowDay, flowToday, utcDayStart } from '../src/flow-day';

/** One project and one current UTC day. The day itself is the idempotency key. Supply it
 * explicitly so replaying the operator command after midnight cannot update a different day. */
export const backfill = internalMutation({
  args: { projectId: v.id('hostedProjects'), dayStart: v.number() },
  returns: v.object({
    status: v.union(v.literal('rebuilt'), v.literal('already-rebuilt'), v.literal('day-changed')),
    receipts: v.number(),
    landed: v.number(),
    partial: v.array(v.string()),
  }),
  handler: async (ctx, { projectId, dayStart }) => {
    const now = Date.now();
    if (dayStart !== utcDayStart(now))
      return { status: 'day-changed' as const, receipts: 0, landed: 0, partial: [] };
    const old = await lineSummary(ctx.db, projectId);
    const value = old ? JSON.parse(old.value) : {};
    let day = flowDay(value.flow);
    const rebuilt = day.repair?.day !== dayStart;
    let receipts = 0;
    if (rebuilt) {
      ({ day, receipts } = await readFlowLandings(ctx.db, projectId, now, day));
      const retained = await retainedMainVerdict(ctx.db, projectId);
      const red = retained.main?.red ?? retained.audit?.red;
      if (red !== undefined && day.main?.red !== red) {
        delete day.main;
        delete day.audit;
        Object.assign(day, retained);
      }
      const row = {
        kind: 'projectLiveLineSummary',
        sourceId: String(projectId),
        projectId,
        value: JSON.stringify({ ...value, flow: day }),
      };
      if (old) await ctx.db.replace(old._id, row);
      else await ctx.db.insert('projectFinishReadRows', row);
    }
    const { landed, partial } = flowToday(day, now, dayStart);
    return {
      status: rebuilt ? ('rebuilt' as const) : ('already-rebuilt' as const),
      receipts,
      landed,
      partial,
    };
  },
});

/** Holds a supersede left behind (Issue f5c4d136): before the fix a superseded Lane kept the hold its ended
 * submission set (stage Saved), so the project list and top bar counted a hold nobody acts on. The operator lifts each
 * such hold as the supersede patch now does, 100 marks a page in the stable project-and-Lane order, with one point
 * read of the overlap row per held mark and one patch per lifted hold. Idempotent; `dryRun` names the marks without
 * writing. Follow `cursor` until it is null. */
export const supersededHolds = internalMutation({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()), dryRun: v.boolean() },
  returns: v.object({
    checked: v.number(),
    lifted: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { projectId, cursor, dryRun }) => {
    const page = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: 100 });
    const lifted = [];
    for (const mark of page.page) {
      if (!mark.held || mark.stage !== 'saved') continue;
      const row = await ctx.db.get(mark.sourceId);
      if (!row?.open || row.superseded?.laneHead !== row.head) continue;
      if (!dryRun) await changeLineMark(ctx.db, mark, { held: false, fix: undefined });
      lifted.push(mark.laneId);
    }
    return { checked: page.page.length, lifted, cursor: page.isDone ? null : page.continueCursor };
  },
});
