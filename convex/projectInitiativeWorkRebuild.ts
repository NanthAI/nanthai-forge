// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { isPlanningUuid } from '../src/planning-id';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalMutation } from './server';
import { initiativeWorkIdentity } from './projectInitiativeWorkFields';
import { initiativeLandingPaths } from './projectInitiativeWorkFold';
import {
  activeWorkRoot,
  foldWorkReceipt,
  initiativeWorkSummary,
  nextWorkInitiative,
  requestWorkRebuild,
  workCounts,
  workMembers,
  WORK_PATHS_PAGE,
  type InitiativeWorkIdentity,
} from './projectInitiativeWorkStore';
import { itemLandingHistory, landingHistoryCursor } from './projectItemLandingHistory';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

type History = Awaited<ReturnType<typeof itemLandingHistory>>;
type Cursor = {
  partition: Id<'projectWorkGenerations'>;
  position: number;
  history?: NonNullable<History['next']>;
  pending?: History['rows'];
};
const advanceRebuild = makeFunctionReference<'mutation'>('projectInitiativeWorkRebuild:advance');
const refreshSummaries = makeFunctionReference<'mutation'>('projectInitiativeWorkRebuild:refresh');

/** Scoped operator backfill and repair. Planning moves use the same rebuild. */
export const backfill = internalMutation({
  args: initiativeWorkIdentity,
  returns: v.object({ id: v.string() }),
  handler: async (ctx, scope) => {
    invariant(isPlanningUuid(scope.initiativeId), 'BAD_ARGUMENT', 'Select a full Initiative UUID.');
    const project = await ctx.db.get(scope.projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    invariant(generation, 'NOT_FOUND', 'Select an existing Initiative.');
    const partition = recordPartition(generation);
    const root = await record(ctx, partition, 'planningSearch', scope.initiativeId);
    invariant(activeWorkRoot(root, 'initiative'), 'NOT_FOUND', 'Select an existing Initiative.');
    return { id: (await requestWorkRebuild(ctx, scope, partition, true))! };
  },
});

/** Jump between Initiative prefixes, without scanning any receipt or path history. */
export const refresh = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    partition: v.id('projectWorkGenerations'),
    after: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, partition, after = '' }) => {
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    if (!generation || recordPartition(generation) !== partition) return null;
    for (let i = 0; i < 8; i++) {
      const row = await nextWorkInitiative(ctx, projectId, after);
      if (!row) return null;
      after = row.initiativeId;
      const scope = { projectId, initiativeId: after };
      await requestWorkRebuild(ctx, scope, partition);
    }
    await ctx.scheduler.runAfter(0, refreshSummaries, { projectId, partition, after });
    return null;
  },
});

async function nextItem(ctx: MutationCtx, scope: InitiativeWorkIdentity, cursor: Cursor) {
  return ctx.db
    .query('projectPlanningRecords')
    .withIndex('by_planning_initiativeId_and_kind', q =>
      q
        .eq('generationId', cursor.partition)
        .eq('collection', 'planningSearch')
        .eq('planning.initiativeId', scope.initiativeId)
        .eq('planning.kind', 'issue')
        .gte('position', cursor.position),
    )
    .first();
}

export const advance = internalMutation({
  args: { ...initiativeWorkIdentity, id: v.string(), step: v.number(), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { projectId, initiativeId, id, step, cursor }) => {
    const scope = { projectId, initiativeId };
    const summary = await initiativeWorkSummary(ctx, scope);
    if (summary?.rebuild?.id !== id || summary.rebuild.step !== step) return null;
    const next = (after?: Cursor) =>
      ctx.scheduler.runAfter(0, advanceRebuild, {
        ...scope,
        id,
        step: step + 1,
        ...(after ? { cursor: JSON.stringify(after) } : {}),
      });
    if (summary.rebuild.phase === 'clear') {
      const members = await workMembers(ctx, scope).take(WORK_PATHS_PAGE);
      for (const row of members) await ctx.db.delete(row._id);
      await ctx.db.patch(summary._id, {
        rebuild: { id, step: step + 1, phase: members.length === WORK_PATHS_PAGE ? 'clear' : 'scan' },
      });
      await next();
      return null;
    }
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    if (!generation) return null;
    const partition = recordPartition(generation);
    const from: Cursor = cursor ? JSON.parse(cursor) : { partition, position: 0 };
    if (summary.partition !== partition || from.partition !== partition) {
      await requestWorkRebuild(ctx, scope, partition);
      return null;
    }
    const row = await nextItem(ctx, scope, from);
    if (!row) {
      await ctx.db.patch(summary._id, {
        summary: { ...workCounts(summary), partition, stale: false },
        rebuild: undefined,
      });
      return null;
    }
    const after: Cursor = { partition, position: row.position + 1 };
    const counts = workCounts(summary);
    if (activeWorkRoot(row, 'issue')) {
      // A pre-Deploy-B stream cursor and its buffered rows must be replayed against the Item range.
      // Receipt identity makes the replay safe for work folded before the deploy.
      const cursor = landingHistoryCursor.safeParse(from.history);
      const history =
        from.pending && (from.history === undefined || cursor.success)
          ? { rows: from.pending, next: cursor.data }
          : await itemLandingHistory(ctx, projectId, row.key, cursor.data);
      let remaining = WORK_PATHS_PAGE;
      for (const [index, receipt] of history.rows.entries()) {
        const paths = () => initiativeLandingPaths(ctx, projectId, receipt.receiptId, receipt.commit);
        const { used, pending } = await foldWorkReceipt(
          ctx,
          scope,
          counts,
          receipt.receiptId,
          paths,
          remaining,
        );
        remaining -= used;
        if (pending || (remaining === 0 && index + 1 < history.rows.length)) {
          after.position = row.position;
          after.pending = history.rows.slice(pending ? index : index + 1);
          break;
        }
      }
      if (after.pending || history.next) {
        after.position = row.position;
        if (history.next) after.history = history.next;
      }
    }
    await ctx.db.patch(summary._id, {
      summary: { ...counts, partition, stale: true },
      rebuild: { id, step: step + 1, phase: 'scan' },
    });
    await next(after);
    return null;
  },
});
