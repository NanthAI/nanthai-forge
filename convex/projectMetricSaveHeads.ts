// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedRecord } from '../src/hosted-records';

export const indexedSaveStatus = 'saved:metric-head';
export const saveHeadKey = (laneId: string, head: string) => canonicalPayload(['save-head', laneId, head]);

export function saveHeadFact(
  projectId: Id<'hostedProjects'>,
  sourceCreatedAt: number,
  save: Extract<HostedRecord, { kind: 'save' }>,
) {
  return {
    projectId,
    key: saveHeadKey(save.laneId, save.head),
    sourceCreatedAt,
    sourceId: save.id,
    value: save.at,
  };
}

/** A separate indexed flag on the existing head certifies that the fact was
 * written in the same transaction. An older writer leaves its saves visible here. */
export const unindexedSaveHeads = (
  ctx: Pick<QueryCtx, 'db'>,
  projectId: Id<'hostedProjects'>,
  since?: number,
) =>
  ctx.db.query('projectHostedRecordHeads').withIndex('by_project_and_kind_and_status', q => {
    const range = q.eq('projectId', projectId).eq('kind', 'save').eq('status', 'saved');
    return since === undefined ? range : range.gte('_creationTime', since);
  });

export async function saveHeadsCovered(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  return (
    project.metricSaveHeadResume?.phase !== 'pending' && !(await unindexedSaveHeads(ctx, project._id).first())
  );
}

/** Invalidation hands the next save one bounded chain. Ordinary saves neither
 * read a migration row nor schedule work. */
export async function resumeSaveHeadBackfill(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const repair = project.metricSaveHeadResume;
  if (!repair || repair.phase === 'scheduled') return;
  // A save may finish in the interval between invalidate and the downgrade.
  // Keep looking until an older writer has actually left a gap.
  const gap = await unindexedSaveHeads(ctx, project._id, repair.requestedAt).first();
  if (!gap && repair.phase === 'watching') return;
  await ctx.db.patch(project._id, {
    metricSaveHeadResume: { ...repair, phase: gap ? 'scheduled' : 'watching' },
  });
  if (gap)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectMetricSaveHeadBackfill:backfillPage'),
      {
        projectId: project._id,
        operationId: repair.operationId,
      },
    );
}
