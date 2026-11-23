// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { changeLineMark, lineSummary } from './projectLiveLineStore';
import { readFlowLandings, retainedMainVerdict } from './projectLiveLineRecovery';
import { flowDay, flowToday, utcDayStart } from '../src/flow-day';
import { ForgeError } from '../src/errors';
import { lineOwner } from './projectLiveLineOwners';
import { loadLanding } from './projectHostedLandingStore';

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

/** Holds written before the `fix` flag existed (Issue f5c4d136): a held mark with no `fix` reads as waiting on a
 * person, so a failed check or conflict from that time would count as Needs you. The operator resolves each such
 * hold's reason from its bound submission, once: it stays a person hold only while that submission waits for review;
 * a hold with no submission (its binding was detached by a newer save, or the submission was removed), or one that
 * waits on its Lane's own next step, is marked `fix` (agent work). A submission that cannot be read for any other
 * reason leaves its mark alone and is listed in `unread`, so a replay finds it again. A page is `limit` marks (25 by
 * default, at most 100) in the stable project-and-Lane order: each submission is read once per page however many
 * marks share it, plus one point read of the owner row per unflagged held mark and one patch per mark marked. Run it
 * after the deploy that adds the flag, per project (`dryRun` names the marks without writing), following `cursor`
 * until it is null. Idempotent. */
export const legacyHolds = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    marked: v.array(v.string()),
    unread: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { projectId, cursor, dryRun, limit }) => {
    const page = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: Math.max(1, Math.min(100, Math.floor(limit ?? 25))) });
    const marked = [];
    const unread = [];
    const waits = new Map<string, boolean | null>();
    for (const mark of page.page) {
      if (!mark.held || mark.fix) continue;
      const submissionId = (await lineOwner(ctx.db, mark.laneId))?.submissionId;
      let person: boolean | null = false;
      if (submissionId) {
        if (!waits.has(submissionId))
          waits.set(
            submissionId,
            await loadLanding(ctx, { projectId, submissionId }).then(
              ({ state }) => state.observation?.pendingReason === 'waiting-for-review',
              (error: unknown) => (error instanceof ForgeError && error.code === 'NOT_FOUND' ? false : null),
            ),
          );
        person = waits.get(submissionId)!;
      }
      if (person === null) unread.push(mark.laneId);
      if (person !== false) continue;
      if (!dryRun) await changeLineMark(ctx.db, mark, { fix: true });
      marked.push(mark.laneId);
    }
    return { checked: page.page.length, marked, unread, cursor: page.isDone ? null : page.continueCursor };
  },
});
