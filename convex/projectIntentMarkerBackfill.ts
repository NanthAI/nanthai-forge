// SPDX-License-Identifier: Apache-2.0
// Item fc1831eb: the one-time marker pass that lets the 7e5f0ad3 no-Item note fallback go. Open Intents written
// before the planningItemId marker have none. An Intent with a same-id Issue gets that Issue's id (what the new
// path writes for a planned Intent); an Intent with no same-id Issue is left alone and counted, so nothing is
// guessed. Bounded pages of PAGE heads, self-continuing, upserts only (a rerun writes nothing new); `dryRun` reads
// one page of one project, writes nothing and returns the counts and the next cursor. Cost, once: PAGE head reads
// plus one Issue-head read and one patch per unmarked head; idle runs read nothing. Deleted after its dev run.
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './server';
import { recordHead } from './projectHostedRecords';

const PAGE = 100;
const PROJECT_PAGE = 10;
const statuses = ['active', 'ready', 'proposed'] as const;
const statusArg = v.union(v.literal('active'), v.literal('ready'), v.literal('proposed'));

export const mark = internalMutation({
  args: {
    projectId: v.optional(v.id('hostedProjects')),
    projectsCursor: v.optional(v.union(v.string(), v.null())),
    status: v.optional(statusArg),
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    scanned: v.number(),
    unmarked: v.number(),
    marked: v.number(),
    noIssue: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    const none = { scanned: 0, unmarked: 0, marked: 0, noIssue: 0 };
    if (!input.projectId) {
      const page = await ctx.db
        .query('hostedProjects')
        .paginate({ cursor: input.projectsCursor ?? null, numItems: PROJECT_PAGE });
      for (const project of page.page)
        if (!project.removal)
          await ctx.scheduler.runAfter(0, internal.projectIntentMarkerBackfill.mark, {
            projectId: project._id,
          });
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, internal.projectIntentMarkerBackfill.mark, {
          projectsCursor: page.continueCursor,
        });
      return { ...none, isDone: page.isDone, continueCursor: page.isDone ? null : page.continueCursor };
    }
    const projectId = input.projectId;
    const status = input.status ?? statuses[0];
    const page = await ctx.db
      .query('projectHostedRecordHeads')
      .withIndex('by_project_and_kind_and_status', q =>
        q.eq('projectId', projectId).eq('kind', 'intent').eq('status', status),
      )
      .paginate({ cursor: input.cursor ?? null, numItems: PAGE });
    const counts = { ...none, scanned: page.page.length };
    for (const head of page.page) {
      if (head.planningItemId !== undefined) continue;
      counts.unmarked++;
      if (!(await recordHead(ctx, projectId, 'issue', head.key))) {
        counts.noIssue++;
        continue;
      }
      if (input.dryRun) continue;
      await ctx.db.patch(head._id, { planningItemId: head.key });
      counts.marked++;
    }
    const nextStatus = statuses[statuses.indexOf(status) + 1];
    const next = !page.isDone
      ? { projectId, status, cursor: page.continueCursor }
      : nextStatus
        ? { projectId, status: nextStatus }
        : null;
    if (next && !input.dryRun)
      await ctx.scheduler.runAfter(0, internal.projectIntentMarkerBackfill.mark, next);
    return { ...counts, isDone: !next, continueCursor: page.isDone ? null : page.continueCursor };
  },
});
