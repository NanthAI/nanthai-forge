// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './server';
import type { LoadedHostedCheck } from './projectHostedCheckStore';

/** The same provider-stop action as Forge Actions; only an unneeded CI run with a bound
 * execution schedules it. The row flag fences duplicate releases and late provider events. */
export async function requestCiCancel(
  ctx: MutationCtx,
  { row, run }: Pick<LoadedHostedCheck, 'row' | 'run'>,
) {
  if (
    run.configuration.provider !== 'ci-status' ||
    run.configuration.ci.adapter !== 'github-actions' ||
    !run.cancelRequested ||
    !run.executionId ||
    row.ciCancel !== undefined
  )
    return;
  await ctx.db.patch(row._id, { ciCancel: 'queued' });
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedActionsWebhook:cancel'), {
    projectId: run.projectId,
    runId: run.id,
  });
}
