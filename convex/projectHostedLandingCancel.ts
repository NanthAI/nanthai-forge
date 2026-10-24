// SPDX-License-Identifier: Apache-2.0
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
    request: z.infer<typeof hostedLandingCancelSchema>;
  },
) {
  const { projectId, actor, request } = input;
  const expected = { authorityEpoch: request.authorityEpoch, resourceId: request.submissionId };
  const payload = { kind: 'hosted-landing-cancel', request };
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
        error: { code: 'LANDING_CANCELLED', message: 'The hosted landing request was cancelled.' },
      };
      await writeLanding(ctx, row, result, false);
      await settleLandingOperation(ctx, result);
      // Invalidate in-flight metadata IO without cancelling shared source/check
      // executions. Late callbacks can retain their evidence but cannot land.
      const finish = await finishRow(ctx, identity);
      if (finish) {
        if (finish.wake) await ctx.scheduler.cancel(finish.wake.taskId);
        await ctx.db.patch(finish._id, { wake: null, waiting: false });
      }
      const queue = await landingQueue(ctx, { projectId, channel: state.request.channel });
      if (queue && (!queue.lease || queue.lease.submissionId === state.id))
        await releaseLandingQueue(ctx, queue);
    }
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
