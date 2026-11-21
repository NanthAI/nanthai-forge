// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { recordLandingFeed } from './projectFeedTerminal';
import { loadBatch, writeBatch } from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import {
  loadLanding,
  landingRow,
  landingStateFromRow,
  loadLandingAttempt,
  landingQueue,
  writeLanding,
  settleLandingOperation,
} from './projectHostedLandingStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { notifyStackedLandingEnded } from './projectHostedStackNotice';
import { canonicalPayload } from '../src/hosted-source-operation';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { finishRow } from './projectHostedFinishWake';
import { releaseLandingQueue } from './projectHostedLandingWake';
import {
  hostedLandingCancelSchema,
  storedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { requireMemberAuthorityById } from './projectLaneAuthority';

/** One metadata transaction races the same request/lease/receipt as final
 * acceptance. OCC retries resolve the winner; cancellation never rewinds main. */
export async function cancelHostedLanding(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    reason?: string;
    request: z.infer<typeof hostedLandingCancelSchema>;
    abandonOperationId?: string;
    /** The stall deadline ended it (metric 5.3): a Forge outcome, not an operator cancel. */
    drop?: true;
    /** The supervisor's typed outcome for a drop (19328518): defaults to LANDING_STALLED. An owner
     * declining a held review (fe5bea80) is an operator cancel with its own outcome code. */
    code?: 'LANDING_DRIVER_EXHAUSTED' | 'REVIEW_DECLINED';
    /** Agent withdraw (78a97771): the Lane whose live landing this cancels, kept in the receipt. */
    withdrawLaneId?: string;
    /** A save of the same Lane moved its head (f7539ebb): the entry ends superseded, not cancelled.
     * The save already authorized the Lane write, so no separate submitter check applies. */
    supersede?: { laneId: string; head: string };
  },
) {
  const { projectId, actor, request } = input;
  const expected = { authorityEpoch: request.authorityEpoch, resourceId: request.submissionId };
  // Automatic child cancellations retain requester and parent provenance without
  // counting as additional operator intervention commands in self-metrics.
  const payload = {
    kind: input.drop
      ? 'hosted-landing-drop'
      : input.supersede
        ? 'hosted-landing-supersede'
        : input.abandonOperationId
          ? 'hosted-abandon-landing-cancel'
          : 'hosted-landing-cancel',
    request,
    ...(input.abandonOperationId ? { parentOperationId: input.abandonOperationId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.code === 'REVIEW_DECLINED' ? { code: input.code } : {}),
    ...(input.withdrawLaneId ? { withdraw: { laneId: input.withdrawLaneId } } : {}),
    ...(input.supersede ? { supersede: input.supersede } : {}),
  };
  const { operation } = await beginHostedOperation(ctx, {
    projectId,
    actor,
    payload,
    request: {
      schema: 1,
      projectId,
      actor,
      operationId: request.operationId,
      expected,
      payloadHash: hostedPayloadHash(payload, expected),
    },
    firstAttempt: {
      projectId,
      operationId: request.operationId,
      id: crypto.randomUUID(),
      parentAttemptId: null,
      at: new Date().toISOString(),
      expected,
      ids: {},
    },
  });
  if (operation.terminal) {
    invariant(
      operation.terminal.outcome.status === 'completed',
      'SOURCE_UNAVAILABLE',
      'Cancellation receipt is unavailable.',
    );
    return storedLandingStateSchema.parse(operation.terminal.outcome.result);
  }
  const identity = { projectId, submissionId: request.submissionId };
  const canonical = await landingRow(ctx, identity);
  if (!canonical) {
    const desired = await desiredLanding(ctx, identity);
    invariant(desired, 'NOT_FOUND', 'Hosted landing request not found.');
    const previous = storedLandingStateSchema.parse(JSON.parse(desired.value));
    if (!input.drop && !input.abandonOperationId && !input.supersede)
      await requireMemberAuthorityById(ctx, projectId, previous.actor, actor, 'landing');
    const state =
      previous.phase === 'terminal-failed'
        ? previous
        : storedLandingStateSchema.parse({
            ...previous,
            version: previous.version + 1,
            phase: 'terminal-failed',
            observation: input.supersede
              ? { state: 'superseded', pendingReason: null, cause: null }
              : landingObservation('cancelled'),
            error: {
              code: input.supersede
                ? 'LANDING_SUPERSEDED'
                : input.drop
                  ? (input.code ?? 'LANDING_STALLED')
                  : 'LANDING_CANCELLED',
              message:
                input.reason ??
                (input.supersede
                  ? 'The source preparation was superseded.'
                  : 'The source preparation was cancelled.'),
            },
            timing: { ...previous.timing, submittedAt: previous.at, settledAt: new Date().toISOString() },
          });
    if (desired.wake) await cancelPendingTask(ctx, desired.wake.taskId);
    if (desired.alarm) await cancelPendingTask(ctx, desired.alarm.taskId);
    await ctx.db.patch(desired._id, {
      value: canonicalPayload(state),
      wake: null,
      alarm: null,
      preparing: undefined,
    });
    if (previous.phase !== 'terminal-failed') await recordLandingFeed(ctx, state);
    await notifyStackedLandingEnded(ctx, {
      projectId,
      actor: state.actor,
      composeOperationId: state.request.finish?.composeOperationId,
      operationId: state.operationId,
      code: state.error!.code,
    });
    await finishHostedOperation(ctx, {
      projectId,
      actor,
      operationId: request.operationId,
      receipt: {
        attemptId: operation.firstAttempt.id,
        at: new Date().toISOString(),
        outcome: { status: 'completed', result: state },
      },
    });
    return state;
  }
  invariant(canonical, 'NOT_FOUND', 'Hosted landing request not found.');
  const row = canonical,
    state = landingStateFromRow(row);
  // An operator cancel needs the submitter or the project owner. Forge's own stall/exhaust drops and
  // the children of an already authorized Lane abandon carry that authority with them.
  if (!input.drop && !input.abandonOperationId && !input.supersede)
    await requireMemberAuthorityById(ctx, projectId, state.actor, actor, 'landing');
  const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: state.attemptId });
  const accepted = await acceptanceRow(ctx, { projectId, receiptId: attempt.operations.accept });
  let result = state;
  if (accepted) {
    const receipt = hostedAcceptanceSchema.parse(JSON.parse(accepted.value));
    invariant(
      receipt.submissionId === state.id &&
        receipt.attemptId === state.attemptId &&
        state.phase === 'landed' &&
        state.acceptance?.receiptId === receipt.id &&
        state.acceptance.head === receipt.candidate.head,
      'SOURCE_UNAVAILABLE',
      'The accepted request and receipt differ.',
    );
  } else {
    invariant(state.phase !== 'landed', 'SOURCE_UNAVAILABLE', 'The accepted request receipt is unavailable.');
    if (state.phase !== 'terminal-failed') {
      result = {
        ...state,
        version: state.version + 1,
        phase: 'terminal-failed',
        observation: input.supersede
          ? { state: 'superseded', pendingReason: null, cause: null }
          : landingObservation('cancelled'),
        error: {
          code: input.supersede
            ? 'LANDING_SUPERSEDED'
            : input.drop
              ? (input.code ?? 'LANDING_STALLED')
              : input.code === 'REVIEW_DECLINED'
                ? input.code
                : 'LANDING_CANCELLED',
          message: input.reason ?? 'The hosted landing request was cancelled.',
        },
      };
      result = await writeLanding(ctx, row, result, false);
      await settleLandingOperation(ctx, result);
    }
    const batchId = state.batchId ?? state.batchOriginId;
    if (batchId) {
      const key = { projectId, batchId };
      const { batch } = await loadBatch(ctx, key);
      const rejected = batch.included && !batch.included.includes(state.id) && batch.phase !== 'fallback';
      if (!rejected) {
        const transition = {
          code: result.error?.code ?? 'LANDING_CANCELLED',
          message: result.error?.message ?? 'A batch member was cancelled.',
        };
        await writeBatch(ctx, key, {
          ...batch,
          phase: batch.phase === 'landed' ? 'landed' : 'fallback',
          transition,
        });
        // This member's finish never runs again, and it may hold the individual
        // fallback turn: hand the turn on now (Issue 108a24e3, peers queued 36 h).
        if (batch.phase !== 'landed')
          await advanceBatchFallback(ctx, key, (await loadBatch(ctx, key)).batch, state.id);
      }
      result = (await loadLanding(ctx, identity)).state;
    }
    // Invalidate cancelled member IO after release has scheduled its peers.
    const finish = await finishRow(ctx, identity);
    if (finish) {
      await cancelPendingTask(ctx, finish.wake?.taskId);
      await ctx.db.patch(finish._id, { wake: null, waiting: false });
    }
    const queue = await landingQueue(ctx, { projectId, channel: state.request.channel });
    if (queue && (!queue.lease || queue.lease.submissionId === state.id))
      await releaseLandingQueue(ctx, queue);
  }
  await finishHostedOperation(ctx, {
    projectId,
    actor,
    operationId: request.operationId,
    receipt: {
      attemptId: operation.firstAttempt.id,
      at: new Date().toISOString(),
      outcome: { status: 'completed', result },
    },
  });
  return result;
}
