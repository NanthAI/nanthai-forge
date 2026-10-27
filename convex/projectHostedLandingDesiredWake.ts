// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
type Row = Doc<'projectHostedLandingDesired'>;
export const desiredLanding = (
  ctx: MutationCtx | QueryCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
export async function scheduleDesired(ctx: MutationCtx, row: Row, delay: number) {
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  const id = crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    delay,
    makeFunctionReference<'action'>('projectHostedLandingDesired:drive'),
    { projectId: row.projectId, submissionId: row.submissionId, wakeId: id },
  );
  await ctx.db.patch(row._id, { wake: { id, taskId } });
  return id;
}
export async function notifyDesiredCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  composeOperationId: string,
) {
  const rows = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', composeOperationId),
    )
    .take(1);
  if (rows[0]?.wake) await scheduleDesired(ctx, rows[0], 0);
}
