// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { finishQuery } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { lineSummary } from './projectLiveLineStore';
import { retainedMainVerdict } from './projectLiveLineRecovery';
import { legacyLineMain } from './projectLiveLineLegacy';
import { finishReadSourceDb } from './projectFinishReadReader';
import { liveLineStage } from './projectLiveLineFields';
import { lineChecks, lineChecksView } from './projectLiveLineChecks';
import { report } from './errors';
import { invariant } from '../src/errors';
import { flowDay } from '../src/flow-day';

const mainView = v.object({
  head: v.string(),
  at: v.optional(v.string()),
  actor: v.optional(v.string()),
  automatic: v.optional(v.boolean()),
  check: v.optional(v.string()),
});
/** One bounded project subscription. No paths, source bodies, Work generation or activity records. */
export const liveLineResult = v.object({
  lanes: v.array(
    v.object({
      laneId: v.string(),
      stage: liveLineStage,
      held: v.boolean(),
      overlap: v.boolean(),
      changedAt: v.number(),
      check: v.optional(v.string()),
      mainRed: v.optional(v.literal(true)),
    }),
  ),
  more: v.number(),
  moreIsLowerBound: v.boolean(),
  main: v.union(mainView, v.null()),
  exit: v.union(
    v.object({
      laneId: v.string(),
      kind: v.union(v.literal('landed'), v.literal('set-aside')),
      at: v.number(),
    }),
    v.null(),
  ),
  checks: v.optional(lineChecksView),
  /** The Flow view's running day (src/flow-day.ts), from the same summary row; absent until its first step. */
  flow: v.optional(
    v.object({
      hours: v.array(v.array(v.number())),
      took: v.array(v.array(v.number())),
      main: v.optional(v.object({ red: v.boolean(), since: v.number() })),
      audit: v.optional(v.object({ red: v.boolean(), at: v.optional(v.number()) })),
      repair: v.optional(v.object({ day: v.number(), partial: v.array(v.string()) })),
      /** [hour, first-try landings, landings judged] (Item 32e8de50). */
      first: v.optional(v.array(v.array(v.number()))),
    }),
  ),
});
export const read = finishQuery({
  args: { projectId: v.id('hostedProjects'), includeChecks: v.optional(v.boolean()) },
  returns: liveLineResult,
  handler: async (ctx, { projectId, includeChecks = true }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const [marks, summary] = await Promise.all([
        ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_held', q => q.eq('projectId', projectId))
          .order('desc')
          .take(101),
        lineSummary(ctx.db, projectId),
      ]);
      const value: {
        main?: import('convex/values').Infer<typeof mainView>;
        exit?: import('convex/values').Infer<typeof liveLineResult>['exit'];
        flow?: unknown;
      } = summary ? JSON.parse(summary.value) : {};
      let main = value.main ?? null;
      // An untouched pre-upgrade project still shows its accepted main. This is an
      // immutable single-receipt read, never a Work-generation dependency or repair.
      if (!main) {
        const channel = await ctx.db
          .query('projectFinishReadRows')
          .withIndex('by_kind_and_project_and_channel', q =>
            q.eq('kind', 'projectHostedChannels').eq('projectId', projectId).eq('channel', 'main'),
          )
          .unique();
        const canonical = channel
          ? null
          : await ctx.db
              .query('projectHostedChannels')
              .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
              .unique();
        if (channel || canonical) {
          const head = channel ? JSON.parse(channel.value).head : JSON.parse(canonical!.selection).head;
          const [accepted] = await ctx.db
            .query('projectHostedAcceptances')
            .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
            .order('desc')
            .take(1);
          const receipt = accepted ? JSON.parse(accepted.value) : null;
          main =
            receipt?.candidate.head === head
              ? {
                  head,
                  at: receipt.at,
                  actor: receipt.actor.id,
                  automatic: receipt.automatic,
                  ...(receipt.check ? { check: 'passed' } : {}),
                }
              : { head };
        }
      }
      if (!main && project.sourceAuthority?.mode !== 'server') {
        const sourceDb = finishReadSourceDb(ctx);
        const original = await sourceDb.get(projectId);
        if (original?.work?.generationId)
          main = await legacyLineMain(sourceDb, projectId, original.work.generationId);
      }
      const flow = flowDay(value.flow);
      if (!flow.main && !flow.audit && main)
        Object.assign(flow, await retainedMainVerdict(ctx.db, projectId));
      const checks = includeChecks ? await lineChecks(finishReadSourceDb(ctx), project, marks) : undefined;
      return {
        ...(checks ? { checks } : {}),
        lanes: marks.slice(0, 60).map(({ laneId, stage, held, overlap, changedAt, check, mainRed }) => ({
          laneId,
          stage,
          held,
          overlap,
          changedAt,
          ...(check ? { check } : {}),
          ...(mainRed ? { mainRed } : {}),
        })),
        more: Math.max(0, marks.length - 60),
        moreIsLowerBound: marks.length === 101,
        main,
        exit: value.exit ?? null,
        ...(value.flow || flow.main || flow.audit ? { flow } : {}),
      };
    } catch (error) {
      return report(error);
    }
  },
});
