// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchState';
import { loadLanding, writeLanding } from './projectHostedLandingStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { composeRow, composeStateSchema } from './projectHostedComposeStore';
import { splitLandingBatch } from './projectHostedLandingBatchSplit';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import { COHORT_STALL_OWNER, hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { HOSTED_TRAIN_HOLD_MS } from '../src/hosted-landing-batch';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { LandingStall } from '../src/landing-stall';

/** Incident 8c9b84fc: dropping a dead composing train must repair its owner in that same
 * transaction. First replay the exact generation; a second loss splits it through existing recovery.
 * Failure-path only: bounded cohort metadata, no source reads, no new call on a healthy train. */
export async function repairComposingBatch(ctx: MutationCtx, input: BatchIdentity, batch: LandingBatch) {
  if (batch.phase !== 'composing') return false;
  const leaderId = batch.leaderId ?? batch.id;
  const loaded = await loadLanding(ctx, { projectId: input.projectId, submissionId: leaderId });
  if (loaded.state.phase !== 'queued' || loaded.state.batchId !== batch.id) return false;
  const finish = await finishRow(ctx, { projectId: input.projectId, submissionId: leaderId });
  const task = finish?.wake ? await ctx.db.system.get(finish.wake.taskId) : null;
  const previousStall = loaded.state.observation.stall;
  // The train wake and leader alarm can reach the same recovery round. One replay owns
  // the whole window; its peer must not diagnose that freshly armed wake as another loss.
  if (previousStall?.owner && Date.now() < Date.parse(previousStall.alarmAt) + HOSTED_TRAIN_HOLD_MS)
    return false;
  const source = await composeRow(ctx, {
    projectId: input.projectId,
    actor: batch.members[0]!.actor.id,
    operationId: batch.composeOperationId,
  });
  const phase = source ? composeStateSchema.parse(JSON.parse(source.value)).status : null;
  const owner: NonNullable<LandingStall['owner']> = {
    finishWake: task?.state.kind ?? 'none',
    compose:
      phase === null
        ? 'none'
        : phase === 'submitted'
          ? 'submitted'
          : phase === 'completed' || phase === 'failed'
            ? 'terminal'
            : 'ready',
    ...(batch.drive ? { cohortStep: batch.drive.step } : {}),
  };
  const stalled = loaded.state.observation.stall;
  const at = new Date(Date.now()).toISOString();
  const stall: LandingStall = {
    code: 'LANDING_STALLED',
    step: 'composing',
    missingOwner: COHORT_STALL_OWNER,
    lastProgressAt: hostedLandingProgressAt(loaded.state),
    alarmAt: at,
    message: 'The cohort compose lost its drive; Forge is replaying the retained generation.',
    owner,
  };
  await writeLanding(
    ctx,
    loaded.row,
    {
      ...loaded.state,
      version: loaded.state.version + 1,
      observation: { ...loaded.state.observation, stall },
    },
    false,
  );
  if (stalled?.owner || !finish) {
    await splitLandingBatch(ctx, input, batch);
    return true;
  }
  await ctx.db.patch(
    (await ctx.db
      .query('projectHostedLandingBatches')
      .withIndex('by_project_and_batch', q => q.eq('projectId', input.projectId).eq('batchId', input.batchId))
      .unique())!._id,
    { value: canonicalPayload({ ...batch, drive: { step: 'retry', at } }) },
  );
  await scheduleFinish(ctx, finish, 0, true);
  // A train wake can repair before the alarm at this same bound is consumed. Replace
  // that retained alarm too; overwriting its pointer would leave a terminal idle task.
  if (loaded.row.alarm) await cancelPendingTask(ctx, loaded.row.alarm.taskId);
  await ctx.db.patch(loaded.row._id, {
    alarm: await armLandingAlarm(
      ctx,
      { projectId: input.projectId, submissionId: leaderId },
      stall.lastProgressAt,
      HOSTED_TRAIN_HOLD_MS,
    ),
  });
  return true;
}
