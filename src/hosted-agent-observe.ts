// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isNetworkPending } from './network-continuation.js';
import { retryHostedObservation } from './hosted-observation-retry.js';
import { deadlineConvexSubscription } from './network-convex-client.js';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { z } from 'zod';
import { resolveAuthToken } from './auth-store.js';
import { hostedCheckRequestSchema, hostedCheckStatusSchema, hostedCheckTerminal } from './hosted-check.js';
import { ForgeError, invariant } from './errors.js';
import { olderEpochRefusal } from './hosted-main-pin.js';
import { settleTurnWork } from './agent-turn-work.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { replyIssuePaths, safeParseHostedResponse } from './hosted-response.js';
import { replySkewError } from './hosted-reply-skew.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import {
  boardConflictEnvelope,
  boardWaker,
  freshBoardDelivery,
  type BoardDelivery,
  type BoardWaitOption,
} from './hosted-board-wait.js';

export const hostedRunWaitSchema = z
  .object({
    runId: z.uuid(),
    timeoutSeconds: z.number().nonnegative().finite().default(600),
  })
  .strict();
export interface HostedRunSubscription {
  onUpdate(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
    update: (value: unknown) => void,
    error: (error: Error) => void,
  ): () => void;
  close(): Promise<void>;
}
/** Test transport only; production uses the same live client for run and operation waits. */
export const observationWaitHooks: { subscribe?: (address: HostedAgentAddress) => HostedRunSubscription } =
  {};
export function hostedRunSubscription(address: HostedAgentAddress): HostedRunSubscription {
  if (observationWaitHooks.subscribe) return observationWaitHooks.subscribe(address);
  const token = resolveAuthToken(address.url, process.env.FORGE_AUTH_TOKEN);
  invariant(token, 'AUTH_REQUIRED', 'Run nforge login or supply your current Forge sign-in token.');
  const client = deadlineConvexSubscription(address.url, {
    logger: false,
    unsavedChangesWarning: false,
  });
  client.setAuth(async () => token);
  return client;
}
const runSchema = z.object({
  id: z.uuid(),
  projectId: z.string(),
  status: hostedCheckStatusSchema,
  request: z.unknown().optional(),
  currentAuthorityEpoch: z.number().int().nonnegative().optional(),
});
const checkWaitRequest = hostedCheckRequestSchema
  .pick({
    authorityEpoch: true,
    candidateId: true,
    expectedHead: true,
    checkId: true,
    expectedDefinition: true,
    expectedConfiguration: true,
    expectedEnvironment: true,
  })
  .extend({ origin: z.unknown().optional(), gate: z.unknown().optional() })
  .loose();
/** Only an explicit active wait creates a live client. No polling, hydration or worker wake. */
export async function observeHostedRun(
  transport: HostedAgentTransport,
  input: unknown,
  signal?: AbortSignal,
  emit: (value: unknown) => void = () => {},
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(transport.address),
  board?: BoardWaitOption,
) {
  const command = hostedRunWaitSchema.parse(input);
  const previousBoard = transport.waitBoard;
  if (board) transport.waitBoard = board;
  let latest: unknown = null,
    active = true;
  try {
    const response = await retryHostedObservation({
      timeoutSeconds: command.timeoutSeconds,
      signal,
      emit,
      pending: status => ({
        schema: 1 as const,
        transport: 'hosted' as const,
        action: 'observe' as const,
        operationId: null,
        resolved: null,
        result: { status, inProgress: true, run: latest },
      }),
      attempt: (timeoutSeconds, signal) =>
        observeHostedRunOnce(
          transport,
          { ...command, timeoutSeconds },
          signal,
          value => {
            if (!active) return;
            latest = value;
            emit(value);
          },
          subscribe,
          board,
        ),
    });
    return {
      ...response,
      result: {
        ...response.result,
        ...(response.result.status === 'timeout' ? { inProgress: true } : {}),
      },
    };
  } finally {
    transport.waitBoard = previousBoard;
    active = false;
  }
}
async function observeHostedRunOnce(
  transport: HostedAgentTransport,
  input: unknown,
  signal: AbortSignal,
  emit: (value: unknown) => void,
  subscribe: () => HostedRunSubscription,
  board?: BoardWaitOption,
) {
  const command = hostedRunWaitSchema.parse(input);
  const initial = await transport.dispatch('observe', { runId: command.runId });
  if (isNetworkPending(initial))
    throw new ForgeError(
      'EXCHANGE_REQUEST_FAILED',
      'Observation is unavailable; retain the original selection.',
    );
  function run(value: unknown) {
    value = typeof value === 'string' ? JSON.parse(value) : value;
    const parsed = safeParseHostedResponse(runSchema, value);
    // A run reply this CLI cannot read (a deploy changed it, Issue 71ef0a66) says nothing about the run.
    if (!parsed.success)
      throw replySkewError(
        'run observation',
        replyIssuePaths(parsed.error.issues),
        (initial as { serverContract?: { missing?: unknown[] } }).serverContract?.missing?.length
          ? 'server-older'
          : 'cli-older',
        {
          outcome: 'The check may have finished; this failed read changes nothing.',
          command: hostedRecoveryCommand(transport.root, 'status', {
            ...transport.address,
            runId: command.runId,
          }),
        },
      );
    invariant(
      parsed.data.id === command.runId && parsed.data.projectId === transport.address.projectId,
      'HOSTED_PROTOCOL_INVALID',
      'Run observation differs from the selected project/run.',
    );
    const { currentAuthorityEpoch } = parsed.data;
    const terminal = hostedCheckTerminal(parsed.data);
    const request =
      !terminal && currentAuthorityEpoch !== undefined
        ? checkWaitRequest.safeParse(parsed.data.request).data
        : undefined;
    if (request && currentAuthorityEpoch !== undefined && request.authorityEpoch < currentAuthorityEpoch) {
      settleTurnWork([command.runId]);
      if (request.origin || request.gate)
        throw new ForgeError(
          'SOURCE_AUTHORITY_CHANGED',
          'Source authority changed before this check run finished. Restart it through its original workflow.',
          undefined,
          { runId: command.runId },
        );
      const {
        candidateId,
        expectedHead,
        checkId,
        expectedDefinition,
        expectedConfiguration,
        expectedEnvironment,
      } = request;
      throw olderEpochRefusal(
        transport.root,
        'SOURCE_AUTHORITY_CHANGED',
        'This check run',
        request.authorityEpoch,
        currentAuthorityEpoch,
        {
          action: 'check',
          parameters: {
            candidateId,
            expectedHead,
            checkId,
            expectedDefinition,
            expectedConfiguration,
            expectedEnvironment,
          },
        },
      );
    }
    return { value, terminal };
  }
  const boardWait = transport.advertisedFeatures?.includes('run-board-wait') ? board : undefined;
  let latest = initial.result;
  let terminal = run(latest).terminal;
  const result = (status: 'terminal' | 'timeout' | 'cancelled' | 'message', delivery?: BoardDelivery) => ({
    ...initial,
    ...boardConflictEnvelope(boardWait?.laneId, latest),
    result: { status, run: latest, ...(delivery ? { board: delivery } : {}) },
  });
  emit(latest);
  if (terminal) return result('terminal');
  if (signal?.aborted) return result('cancelled');
  if (!command.timeoutSeconds) {
    const delivery = boardWait ? freshBoardDelivery(boardWait, latest) : undefined;
    return delivery ? result('message', delivery) : result('timeout');
  }
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let waker: ReturnType<typeof boardWaker> | undefined;
  try {
    return await new Promise<ReturnType<typeof result>>((resolve, reject) => {
      waker = boardWait ? boardWaker(boardWait, delivery => resolve(result('message', delivery))) : undefined;
      stop = () => resolve(result('cancelled'));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedCheckRead:status'),
        {
          projectId: transport.address.projectId,
          runId: command.runId,
          features: [
            'ci-status-check',
            'check-report-detail',
            ...(transport.advertisedFeatures?.includes('source-epoch-recovery')
              ? ['check-authority-epoch']
              : []),
          ],
          ...(boardWait ? { board: { laneId: boardWait.laneId, after: boardWait.after } } : {}),
        },
        value => {
          try {
            const next = run(value);
            latest = next.value;
            terminal = next.terminal;
            emit(latest);
            if (terminal) resolve(result('terminal'));
            else waker?.offer(next.value);
          } catch (error) {
            reject(error);
          }
        },
        error => reject(hostedActionError(error, 'run observation')),
      );
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new ForgeError('HOSTED_PROTOCOL_INVALID', 'Hosted run observation is invalid.');
    throw hostedActionError(error, 'run observation');
  } finally {
    waker?.stop();
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}
