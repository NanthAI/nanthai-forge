// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { beganAtOlderEpoch, olderEpochRefusal } from './hosted-main-pin.js';
import { revertRequestSchema } from './hosted-sync.js';
import { sourceWaitSnapshot, waitHostedAgentSource } from './hosted-agent-source-wait.js';
import type { HostedAgentResponse, HostedAgentTransport } from './hosted-agent-transport.js';
import { freshBoardDelivery, readBoardServerFeatures, type BoardWaitOption } from './hosted-board-wait.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import type { HostedTerminalReceipt } from './hosted-source-operation.js';

type RevertProgress = {
  state?: { request?: unknown };
  authorityEpoch?: number;
  terminal?: HostedTerminalReceipt | null;
};

function unregisteredRevert(root: string, operationId: string, command: Record<string, unknown>) {
  const parameters = { ...command, operationId };
  return new ForgeError(
    'NOT_FOUND',
    'The server has no record of this revert. Replay its original command.',
    undefined,
    {
      next: { action: 'revert', ...parameters },
      command: hostedRecoveryCommand(root, 'revert', parameters),
    },
  );
}

/** The revert verb's exact receipt, observed without replaying prepare or submit. */
export async function observeHostedRevert(
  transport: HostedAgentTransport,
  operationId: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  board?: BoardWaitOption,
  retained?: Record<string, unknown>,
) {
  const deadline = performance.now() + timeoutSeconds * 1000;
  const features = transport.advertisedFeatures ?? readBoardServerFeatures(transport.address.projectId);
  const boardWait = features.includes('source-board-wait') ? board : undefined;
  const boardArgs = boardWait ? { board: { laneId: boardWait.laneId, after: boardWait.after } } : {};
  const response = (
    status: 'terminal' | 'timeout' | 'cancelled' | 'message',
    fields: Record<string, unknown> = {},
  ) => ({
    schema: 1 as const,
    transport: 'hosted' as const,
    action: 'revert' as const,
    operationId,
    resolved: null,
    result: { ...fields, status, phase: 'revert' as const, operationId },
  });
  let command: { message: string; target: unknown } | undefined;
  const inspect = (value: unknown) => {
    const progress = value as RevertProgress | undefined;
    const pin = revertRequestSchema.safeParse(progress?.state?.request);
    if (!pin.success || pin.data.operationId !== operationId) return false;
    const { authorityEpoch: began, message, target } = pin.data;
    command = { message, target };
    const epoch = progress?.authorityEpoch;
    if (epoch !== undefined && beganAtOlderEpoch(began, epoch, progress?.terminal))
      throw olderEpochRefusal(transport.root, 'SOURCE_AUTHORITY_CHANGED', 'This revert', began, epoch, {
        action: 'revert',
        parameters: command,
      });
    return true;
  };
  const missing = (failure: ForgeError) =>
    failure.code === 'NOT_FOUND' && failure.message === 'Prepare this original hosted sync first.';

  let initial;
  if (!timeoutSeconds || !retained) {
    // A finite wait reads once. Without a journal, verify the kind before subscribing to this ID.
    try {
      initial = await transport.query<RevertProgress>('projectHostedSync:progress', {
        operationId,
        ...boardArgs,
      });
    } catch (error) {
      const failure = hostedActionError(error, 'revert observation');
      if (!missing(failure)) throw failure;
      if (retained) throw unregisteredRevert(transport.root, operationId, retained);
      return undefined;
    }
    if (!inspect(initial)) return undefined;
  }
  const delivery = boardWait && freshBoardDelivery(boardWait, initial);
  const remaining = Math.max(0, (deadline - performance.now()) / 1000);
  let awaitingRegistration = false;
  const progress = (
    initial?.terminal || delivery || !remaining
      ? sourceWaitSnapshot(initial)
      : await waitHostedAgentSource(
          transport.address,
          operationId,
          initial,
          signal,
          transport.subscribeSource,
          'Sync',
          remaining,
          value => {
            if (!inspect(value)) throw new ForgeError('NOT_FOUND', 'This operation is not a hosted revert.');
          },
          undefined,
          boardWait,
          failure => {
            if (!retained || command || !missing(failure)) return false;
            awaitingRegistration = true;
            return true;
          },
        )
  ) as
    | (Partial<HostedTerminalReceipt> &
        Pick<HostedAgentResponse, 'conflictNotice' | 'notice'> & {
          status?: 'failed' | 'retryable';
          board?: unknown;
          error?: unknown;
        })
    | undefined;
  if (progress?.outcome) {
    const { conflictNotice, notice, ...receipt } = progress;
    return {
      ...response('terminal', { ...receipt, successful: progress.outcome.status === 'completed' }),
      ...(conflictNotice ? { conflictNotice, notice } : {}),
    };
  }
  if (progress?.status === 'failed' || progress?.status === 'retryable')
    return response('terminal', {
      successful: false,
      sourceStatus: progress.status,
      error: progress.error,
      ...(command
        ? { command: hostedRecoveryCommand(transport.root, 'revert', { ...command, operationId }) }
        : {}),
    });
  const notes = delivery || progress?.board;
  if (notes) return response('message', { board: notes });
  if (signal?.aborted) return response('cancelled');
  if (retained && awaitingRegistration && !command)
    throw unregisteredRevert(transport.root, operationId, retained);
  return response('timeout');
}
