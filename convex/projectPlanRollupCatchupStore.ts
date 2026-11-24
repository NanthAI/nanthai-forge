// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { v, type Infer } from 'convex/values';
import type { MutationCtx, QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { generationHead } from './projectWorkHead';
import { PLAN_COUNTS } from './projectPlanCountsStore';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';

export const catchupWake = makeFunctionReference<'mutation'>('projectPlanRollupCatchup:page');
const key = 'rollup-catchup';
export const catchupFence = v.object({ generation: v.id('projectWorkGenerations'), revision: v.number() });
export const approvedMove = v.object({
  id: v.string(),
  version: v.number(),
  from: v.string(),
  status: v.string(),
  rule: v.string(),
  workStamp: v.string(),
});
type Approval = { expected: Infer<typeof catchupFence>; moves: Infer<typeof approvedMove>[] };
export type CatchupProgress = {
  operationId: string;
  expected: Infer<typeof catchupFence>;
  pass: number;
  after: string;
  step: number;
  moved: number;
  state: 'running' | 'partial' | 'complete';
  reason?: string;
  pending?: Approval['moves'];
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
  const { state, moved, reason } = JSON.parse(row.value) as CatchupProgress;
  if (row.generationId !== partition && state === 'running')
    return { state: 'partial', moved, reason: 'plan-changed' } as const;
  return { state, moved, ...(reason ? { reason } : {}) };
}

/** One retained cursor per selected Plan, no per-Item job rows. Policy toggles start it in their own transaction. */
export async function beginRollupCatchup(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  operationId: string,
  approval?: Approval,
) {
  // The dev operator can retry after a later operation replaced the active cursor, without reapplying it.
  const receiptKey = `plan-rollup-apply:${operationId}`;
  const hash = approval ? digest(JSON.stringify(approval)) : undefined;
  if (hash) {
    const receipt = await ctx.db
      .query('projectJournalReceipts')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', project._id).eq('operationId', receiptKey),
      )
      .unique();
    if (receipt) {
      invariant(
        receipt.hash === hash,
        'WORK_OPERATION_CHANGED',
        'Retry apply with its originally approved preview.',
      );
      return (JSON.parse(receipt.envelope) as { partition: Id<'projectWorkGenerations'> }).partition;
    }
  }
  const selected = await selectedGeneration(ctx, project);
  if (!selected) {
    invariant(!approval, 'PROJECT_WORK_INDEX_MISSING', 'Select a ready Plan before applying the preview.');
    return null;
  }
  const partition = recordPartition(selected);
  const previous = await catchupRow(ctx, partition);
  const generation = await generationHead(ctx, selected);
  const expected = { generation: generation._id, revision: generation.revision };
  invariant(
    !approval ||
      (approval.expected.generation === expected.generation &&
        approval.expected.revision === expected.revision &&
        project.autonomyPolicy?.rollUpPlanningStatus !== false &&
        new Set(approval.moves.map(move => move.id)).size === approval.moves.length),
    'WORK_STALE',
    'The approved Plan fence no longer holds. Nothing was scheduled.',
  );
  const progress: CatchupProgress = {
    operationId,
    expected,
    after: '',
    pass: 0,
    step: 0,
    moved: 0,
    state: 'running',
    ...(approval ? { pending: approval.moves } : {}),
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
  if (hash)
    await ctx.db.insert('projectJournalReceipts', {
      projectId: project._id,
      operationId: receiptKey,
      hash,
      envelope: JSON.stringify({ partition }),
    });
  // The operator checks billed usage before authorizing each dev page. Policy re-enable chains itself.
  if (!approval)
    await ctx.scheduler.runAfter(0, catchupWake, { projectId: project._id, partition, operationId, step: 0 });
  return partition;
}
