// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { expandOperationReceipt } from '../src/compact-operation-receipt';
import { canonicalPayload } from '../src/hosted-source-operation';

export async function hostedOperationRow(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  operationId: string,
) {
  const [row] = await ctx.db
    .query('projectHostedOperations')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', projectId).eq('actor', actor).eq('operationId', operationId),
    )
    .order('desc')
    .take(1);
  if (!row?.journalSegment) return row ?? null;
  return { ...row, value: canonicalPayload(expandOperationReceipt(row)) };
}
