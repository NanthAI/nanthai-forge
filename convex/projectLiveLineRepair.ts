// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { lineSummary } from './projectLiveLineStore';
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
