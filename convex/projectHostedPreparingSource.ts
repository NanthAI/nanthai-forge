// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
/** A preparing landing's source step (incident e62d834b): its compose, then that job's step row, two
 * indexed reads. The queue reads it for every preparing entry; `wait` only once the landing stalled. */
export async function preparingSourceStep(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  composeOperationId: string,
) {
  const compose = await ctx.db
    .query('projectHostedComposes')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', projectId).eq('actor', actor).eq('operationId', composeOperationId),
    )
    .unique();
  return compose
    ? ctx.db
        .query('projectSourceSteps')
        .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', compose.jobId))
        .unique()
    : null;
}
