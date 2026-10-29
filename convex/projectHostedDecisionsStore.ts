import { recordPageOptions } from './projectHostedFrictionStore';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { DecisionRecord, DecisionTarget } from '../src/decision-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
export const decisionTargetKey = (target: DecisionTarget) =>
  target.kind === 'project' ? 'project' : `intent:${target.intentId}`;
export async function decisionRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, id: string) {
  return ctx.db
    .query('projectHostedDecisions')
    .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', id))
    .unique();
}
export async function appendDecision(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  record: DecisionRecord,
) {
  const old = await decisionRow(ctx, projectId, record.id);
  if (old) {
    invariant(
      canonicalPayload(JSON.parse(old.value)) === canonicalPayload(record),
      'WORK_OPERATION_CHANGED',
      'Replay the original decision record.',
    );
    return false;
  }
  await ctx.db.insert('projectHostedDecisions', {
    projectId,
    actor,
    id: record.id,
    request: record.request,
    value: canonicalPayload(record),
    target: decisionTargetKey(record.target),
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  });
  return true;
}
/** Bounded context window; retained history remains available through list cursors. */
export async function hostedBriefDecisions(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedDecisions')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .order('desc')
    .paginate(recordPageOptions(null));
  return {
    decisions: rows.page.reverse().map(row => JSON.parse(row.value) as DecisionRecord),
    more: !rows.isDone,
  };
}
