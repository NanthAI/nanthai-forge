// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { PLAN_COUNTS } from './projectPlanCountsStore';

export const catchupWake = makeFunctionReference<'mutation'>('projectPlanRollupCatchup:page');
const key = 'rollup-catchup';
export type CatchupProgress = {
  operationId: string;
  pass: number;
  after: string;
  step: number;
  moved: number;
  state: 'running' | 'partial' | 'complete';
  reason?: string;
  /** Older operator cursors must stop rather than fall into automatic re-enable catch-up. */
  pending?: unknown[];
};
export const catchupRow = (ctx: QueryCtx, partition: Id<'projectWorkGenerations'>) =>
  ctx.db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', PLAN_COUNTS).eq('key', key),
    )
    .unique();

export async function readRollupCatchup(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
) {
  if (!project.planningRollupCatchup) return undefined;
  const row = await ctx.db.get(project.planningRollupCatchup);
  if (!row || row.projectId !== project._id) return undefined;
  const { state, moved, reason, pending } = JSON.parse(row.value) as CatchupProgress;
  if (pending) return { state: 'partial', moved, reason: 'approval-path-replaced' } as const;
  if (row.generationId !== partition && state === 'running')
    return { state: 'partial', moved, reason: 'plan-changed' } as const;
  return { state, moved, ...(reason ? { reason } : {}) };
}

/** One retained cursor per selected Plan, no per-Item job rows. Policy toggles start it in their own transaction. */
export async function beginRollupCatchup(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  operationId: string,
) {
  const selected = await selectedGeneration(ctx, project);
  if (!selected) return null;
  const partition = recordPartition(selected);
  const previous = await catchupRow(ctx, partition);
  const progress: CatchupProgress = {
    operationId,
    after: '',
    pass: 0,
    step: 0,
    moved: 0,
    state: 'running',
  };
  const value = JSON.stringify(progress);
  const cursor =
    previous?._id ??
    (await ctx.db.insert('projectWorkDataRecords', {
      projectId: project._id,
      generationId: partition,
      collection: PLAN_COUNTS,
      key,
      parent: '',
      position: 0,
      value,
    }));
  if (previous) await ctx.db.patch(cursor, { value });
  if (project.planningRollupCatchup !== cursor)
    await ctx.db.patch(project._id, { planningRollupCatchup: cursor });
  await ctx.scheduler.runAfter(0, catchupWake, { projectId: project._id, partition, operationId, step: 0 });
  return partition;
}
