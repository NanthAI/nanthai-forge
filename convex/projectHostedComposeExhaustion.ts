// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { loadLanding } from './projectHostedLandingStore';
import { composeRow, loadCompose, writeComposeState } from './projectHostedComposeStore';
import { finishHostedOperation } from './projectHostedOperations';
import { failFinish } from './projectHostedFinishStore';
import { exhaustSourceExecution, exhaustSourceWithoutStep } from './projectConvexSourceFailure';
import { loadSourceJob } from './projectSourceJobs';
import { drainSourcePool } from './projectConvexSourcePool';
import { validSourceBatch } from './projectConvexSourceFanout';
import { sourceRetryFailureMessage, unknownSourceFailure } from '../src/hosted-source-retry';
/** The existing compose watch owns settlement as well as reconciliation. This
 * runs only at its cutoff, without adding work to the healthy read/write path. */
export async function exhaustFinishCompose(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  operationId = row.composeOperationId,
) {
  const identity = { projectId: row.projectId, submissionId: row.submissionId };
  const { state } = await loadLanding(ctx, identity);
  if (['landed', 'terminal-failed'].includes(state.phase)) return;
  let cause = unknownSourceFailure('compose-watch'),
    code = 'SOURCE_RETRY_EXHAUSTED';
  const compose = operationId
    ? await composeRow(ctx, { projectId: row.projectId, actor: state.actor, operationId })
    : null;
  if (compose) {
    const loaded = await loadCompose(ctx, compose, false);
    if (loaded.operation.terminal?.outcome.status === 'failed') {
      const error = loaded.operation.terminal.outcome.error;
      await failFinish(ctx, identity, error.code, error.message);
      return;
    }
    if (!loaded.operation.terminal) {
      const step = await ctx.db
        .query('projectSourceSteps')
        .withIndex('by_project_and_job', q => q.eq('projectId', row.projectId).eq('jobId', compose.jobId))
        .unique();
      const job = step
        ? await loadSourceJob(ctx, row.projectId, compose.jobId)
        : loaded.state.status === 'submitted'
          ? await exhaustSourceWithoutStep(
              ctx,
              { projectId: row.projectId, jobId: compose.jobId, operationId: loaded.state.jobOperationId },
              cause,
            )
          : null;
      if (job) {
        if (job.status === 'failed' || job.status === 'cancelled')
          code = job.control!.failureCode ?? 'SOURCE_JOB_CANCELLED';
        cause = job.control!.failureCause ?? step?.lastFailure ?? cause;
        // A terminal job already fixed its cause. Otherwise choose the latest
        // recorded child failure, independently of the four reservations' order.
        let failureAt = step?.lastFailureAt ?? -Infinity;
        if (!job.control!.failureCause && step?.batchId) {
          const pool = await ctx.db
            .query('projectSourcePools')
            .withIndex('by_key', q => q.eq('key', 'source'))
            .unique();
          for (const slot of pool?.active ?? []) {
            if (typeof slot !== 'string' && slot.batch !== step.batchId) continue;
            const task = await ctx.db.get(typeof slot === 'string' ? slot : slot.task);
            if (
              task?.batchId === step.batchId &&
              task.lastFailure &&
              (task.lastFailureAt ?? -Infinity) >= failureAt
            ) {
              cause = task.lastFailure;
              failureAt = task.lastFailureAt ?? -Infinity;
            }
          }
        }
        if (step) await exhaustSourceExecution(ctx, step, cause);
      }
      await finishHostedOperation(ctx, {
        projectId: row.projectId,
        actor: compose.actor,
        operationId: compose.operationId,
        receipt: {
          attemptId: loaded.operation.firstAttempt.id,
          at: loaded.operation.firstAttempt.at,
          outcome: {
            status: 'failed',
            error: {
              code,
              message:
                code === 'SOURCE_RETRY_EXHAUSTED'
                  ? sourceRetryFailureMessage(cause)
                  : 'The original source job did not complete; its inputs and operation are retained.',
            },
          },
        },
      });
      await writeComposeState(ctx, compose._id, { ...loaded.state, status: 'failed' });
      await drainSourcePool(ctx, batch => validSourceBatch(ctx, batch));
    }
  }
  await failFinish(
    ctx,
    identity,
    code,
    code === 'SOURCE_RETRY_EXHAUSTED'
      ? sourceRetryFailureMessage(cause)
      : 'The original source job did not complete; its inputs and operation are retained.',
  );
}
