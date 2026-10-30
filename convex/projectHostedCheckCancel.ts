// SPDX-License-Identifier: Apache-2.0
import { isMachineRunner } from '../src/hosted-machine-runner';
import type { MutationCtx } from './_generated/server';
import {
  loadHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
  type CheckIdentity,
} from './projectHostedCheckStore';
import { requestDirectCancel } from './projectHostedActionsDirect';
import { notifyActionsProgress } from './projectHostedActionsWake';
import { hostedCheckTerminal, checkPin } from '../src/hosted-check';

/** Explicit run cancellation targets the entire run. Landing release opts into
 * indexed live-consumer protection before requesting that same terminal stop. */
export async function cancelHostedCheck(
  ctx: MutationCtx,
  input: CheckIdentity,
  preserveLiveConsumers = false,
) {
  const selected = await loadHostedCheck(ctx, input),
    { row, run } = selected;
  if (hostedCheckTerminal(run)) return run;
  if (preserveLiveConsumers)
    for (const phase of ['queued', 'checking', 'ready'] as const) {
      const live = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_run_and_phase', q =>
          q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', phase),
        )
        .take(1);
      if (live.length) return run;
    }
  run.cancelRequested = true;
  run.status = 'cancelled';
  if (isMachineRunner(run.configuration)) run.fence++;
  run.lease = null;
  run.endedAt = new Date().toISOString();
  run.exitCode = null;
  run.terminalDigest = checkPin({ kind: 'cancelled', runId: run.id, fence: run.fence });
  await completeHostedCheck(ctx, run);
  await writeHostedCheck(ctx, row._id, run);
  await requestDirectCancel(ctx, run);
  // Retain the existing legacy-adapter cleanup wake; direct Actions has none.
  await notifyActionsProgress(ctx, run);
  return run;
}

/** A queued request already pins its check. Probe every live phase before
 * releasing shared work, independent of project/history/batch size. */
export const cancelUnneededHostedCheck = (ctx: MutationCtx, input: CheckIdentity) =>
  cancelHostedCheck(ctx, input, true);
