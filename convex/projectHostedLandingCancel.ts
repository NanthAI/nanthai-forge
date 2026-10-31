// SPDX-License-Identifier: Apache-2.0
import { loadBatch, writeBatch } from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import {
  loadLanding,
  loadLandingAttempt,
  landingQueue,
  writeLanding,
  settleLandingOperation,
} from './projectHostedLandingStore';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { finishRow } from './projectHostedFinishWake';
import { releaseLandingQueue } from './projectHostedLandingWake';
import {
  hostedLandingCancelSchema,
  hostedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

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
  },
) {
  const { projectId, actor, request } = input;
  const expected = { authorityEpoch: request.authorityEpoch, resourceId: request.submissionId };
  // Automatic child cancellations retain requester and parent provenance without
  // counting as additional operator intervention commands in self-metrics.
  const payload = {
    kind: input.drop
      ? 'hosted-landing-drop'
      : input.abandonOperationId
        ? 'hosted-abandon-landing-cancel'
        : 'hosted-landing-cancel',
    request,
    ...(input.abandonOperationId ? { parentOperationId: input.abandonOperationId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
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
    return hostedLandingStateSchema.parse(operation.terminal.outcome.result);
  }
  const identity = { projectId, submissionId: request.submissionId };
  const { row, state } = await loadLanding(ctx, identity);
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
        observation: landingObservation('cancelled'),
        error: {
          code: input.drop ? 'LANDING_STALLED' : 'LANDING_CANCELLED',
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
      await writeBatch(ctx, key, { ...batch, phase: batch.phase === 'landed' ? 'landed' : 'fallback' });
      // This member's finish never runs again, and it may hold the individual
      // fallback turn: hand the turn on now (Issue 108a24e3, peers queued 36 h).
      await advanceBatchFallback(ctx, key, (await loadBatch(ctx, key)).batch, state.id);
      result = (await loadLanding(ctx, identity)).state;
    }
    // Invalidate cancelled member IO after release has scheduled its peers.
    const finish = await finishRow(ctx, identity);
    if (finish) {
      if (finish.wake) await ctx.scheduler.cancel(finish.wake.taskId);
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
