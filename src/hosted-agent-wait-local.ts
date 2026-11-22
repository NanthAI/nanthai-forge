// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import {
  hostedAgentDirectory,
  hostedAgentRoot,
  readAgentJson,
  retainedHostedOperation,
} from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { backgroundSaveName, settledBackgroundSaveName } from './hosted-save-pending.js';
import { applyObservedBackgroundSave, staleEpochSaveRefusal } from './hosted-save-client.js';
import { settleTurnWork } from './agent-turn-work.js';
import { finishRefusedKey } from './hosted-agent-finish-identity.js';
import { preparingFinishSource } from './hosted-agent-finish-result.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { sourceWaitSnapshot } from './hosted-agent-source-wait.js';
import { observeHostedRevert } from './hosted-revert-wait.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { BeganAtOlderEpoch } from './hosted-main-pin.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { readHostedOverlapAdvice } from './hosted-overlap-client.js';
import { restackAfterSave } from './hosted-stack-restack.js';
import { markerIdentity } from './lane-prune.js';
import {
  observeHostedRun,
  hostedRunSubscription,
  type HostedRunSubscription,
} from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import {
  boardConflictEnvelope,
  boardWaker,
  freshBoardDelivery,
  readBoardServerFeatures,
  type BoardWaitOption,
} from './hosted-board-wait.js';

export { observeHostedRevert };

/** What this client's own records say an operation id is, when the server has no landing for it. */
export type LocalOperation =
  | { kind: 'check-run'; runId: string }
  | { kind: 'check-only' }
  | { kind: 'save' }
  | { kind: 'finish'; command: Record<string, unknown> };

export function localOperation(root: string, operationId: string): LocalOperation | undefined {
  const base = hostedAgentRoot(root);
  const path = join(hostedAgentDirectory(base), `${operationId}.json`);
  if (checkoutPathExists(path)) {
    const values = (readAgentJson(path) as { values?: Record<string, unknown> }).values ?? {};
    const run = values['finish-check-run'] as { id?: unknown } | undefined;
    if (typeof run?.id === 'string') return { kind: 'check-run', runId: run.id };
    const request = values['finish-request'] as { channel?: unknown } | undefined;
    const context = values['finish-context'] as { command?: { accept?: unknown } } | undefined;
    const checkOnly = (request && !request.channel) || context?.command?.accept === false;
    // Only a check-only finish that ended before its run (source failed, or refused before anything
    // was submitted) produced no run. One still preparing or reserving its run, or whose enqueue
    // reply was lost, is in progress: it continues by replay like a landing (Issue 17cce1b3).
    if (checkOnly && (values['finish-source-failed'] || values[finishRefusedKey]))
      return { kind: 'check-only' };
    // A landing or check-only finish whose source preparation has not reached submission yet.
    const retained = retainedHostedOperation(base, operationId);
    if (retained?.action === 'finish') return { kind: 'finish', command: retained.command };
    if (checkOnly) return { kind: 'check-only' };
  }
  if (existsSync(join(clientCacheRoot(base), 'saves', operationId))) return { kind: 'save' };
  return undefined;
}

const progressSchema = z.object({
  authorityEpoch: z.number().optional(),
  state: z.object({ request: z.object({ authorityEpoch: z.number().optional() }).optional() }).optional(),
  terminal: z
    .looseObject({
      outcome: z.looseObject({ status: z.string(), result: z.unknown().optional() }),
    })
    .nullable()
    .optional(),
});

/** Preserve the save's existing conditional restack after observing its receipt. */
export async function restackObservedSave<R extends { result: Record<string, unknown> }>(
  transport: HostedAgentTransport,
  reply: R,
  signal: AbortSignal,
) {
  const lane = readHostedLaneCheckout(transport.root)?.selection;
  if (!lane?.stack || lane.stack.detached || lane.head !== reply.result.head || signal.aborted) return reply;
  const { stack } = await readHostedOverlapAdvice(transport, lane.laneId);
  return restackAfterSave({ ...reply, stack }, lane.laneId, (action, input) =>
    transport.dispatch(action, input, signal),
  );
}

/** Acknowledged split saves already have a worker; earlier saves may still need exact replay. */
export function acknowledgedBackgroundSave(root: string, operationId: string): boolean {
  const directory = join(clientCacheRoot(root), 'saves', operationId);
  return (
    checkoutPathExists(join(directory, 'acknowledged')) &&
    (checkoutPathExists(join(directory, backgroundSaveName)) ||
      checkoutPathExists(join(directory, settledBackgroundSaveName)))
  );
}

const response = (result: Record<string, unknown>) => ({
  schema: 1 as const,
  transport: 'hosted' as const,
  action: 'observe' as const,
  operationId: null,
  resolved: null,
  result,
});

/** Read or subscribe to the original save. An acknowledged background save skips the HTTP
 * probe on a live wait: the same subscription sees its first snapshot and every subsequent state. */
export async function observeHostedSave(
  transport: HostedAgentTransport,
  operationId: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  subscribe = transport.subscribeSource ?? (() => hostedRunSubscription(transport.address)),
  board?: BoardWaitOption,
  mode: 'local' | 'unrecorded' | 'background' = 'local',
) {
  const features = transport.advertisedFeatures ?? readBoardServerFeatures(transport.address.projectId);
  const boardWait = features.includes('source-board-wait') ? board : undefined;
  const boardArgs = boardWait ? { board: { laneId: boardWait.laneId, after: boardWait.after } } : {};
  const saveResponse = (result: Record<string, unknown>) =>
    mode === 'background' ? { ...response(result), action: 'save' as const, operationId } : response(result);
  let registered = false;
  let source: unknown;
  const stoppedSource = () => {
    const snapshot = sourceWaitSnapshot(source) as { status?: string } | undefined;
    // A failed worker still has to publish the save's terminal receipt. The
    // subscription stays attached through that separate transaction.
    if (snapshot?.status !== 'retryable') return null;
    const retained = retainedHostedOperation(transport.root, operationId);
    return saveResponse({
      ...snapshot,
      status: 'terminal',
      successful: false,
      phase: 'save',
      operationId,
      outcome: snapshot.status,
      ...(retained
        ? {
            command: hostedRecoveryCommand(transport.root, retained.action, {
              ...retained.command,
              operationId,
            }),
          }
        : {}),
    });
  };
  const terminal = (value: unknown) => {
    const progress = progressSchema.parse(value);
    const receipt = progress.terminal;
    registered = true;
    if (!receipt) {
      if (mode !== 'background') return null;
      const began = progress.state?.request?.authorityEpoch;
      const epoch = progress.authorityEpoch;
      if (began !== undefined && epoch !== undefined && began !== epoch) {
        const error = new BeganAtOlderEpoch(began, epoch);
        const retained = retainedHostedOperation(transport.root, operationId);
        if (!retained || !['save', 'checkpoint'].includes(retained.action)) throw error;
        throw staleEpochSaveRefusal(
          transport.root,
          operationId,
          epoch,
          { action: 'save', parameters: retained.command },
          error,
        );
      }
      if (typeof (value as { jobId?: unknown }).jobId !== 'string') return null;
      source = sourceWaitSnapshot(value);
      return stoppedSource();
    }
    const { outcome } = receipt;
    if (mode === 'background') applyObservedBackgroundSave(transport.root, operationId, receipt);
    const result = outcome.result as { head?: string; sourceVersion?: number } | undefined;
    return {
      ...boardConflictEnvelope(boardWait?.laneId, value),
      ...saveResponse({
        ...(mode === 'background' ? receipt : { outcome: outcome.status }),
        status: 'terminal',
        successful: outcome.status === 'completed',
        phase: 'save',
        operationId,
        ...(result?.head ? { head: result.head, sourceVersion: result.sourceVersion } : {}),
        ...(mode === 'background'
          ? {}
          : {
              next: 'Run preflight or land: they settle the checkout from this original save without repeating it.',
            }),
      }),
    };
  };
  const registering = (error: ForgeError) =>
    mode === 'background' &&
    !registered &&
    error.code === 'NOT_FOUND' &&
    error.message === 'Prepare this original hosted save first.';
  const read = async () => {
    let value: unknown;
    try {
      value = await transport.query('projectHostedSaves:progress', { operationId, ...boardArgs });
    } catch (error) {
      const failure = hostedActionError(error, 'save observation');
      if (registering(failure)) return null;
      if (failure.code !== 'NOT_FOUND' || mode === 'background') throw failure;
      if (mode === 'unrecorded') return undefined;
      return response({
        status: 'terminal',
        successful: false,
        phase: 'save',
        operationId,
        reason: 'The server has no record of this save yet. Replay the original save with this operationId.',
      });
    }
    // Every real save reply carries the save's own state; anything else is not this id's save.
    if (mode === 'unrecorded' && !(value as { state?: unknown } | null)?.state) return undefined;
    const done = terminal(value);
    if (done) return done;
    const delivery = boardWait ? freshBoardDelivery(boardWait, value) : undefined;
    return delivery ? saveResponse({ status: 'message', board: delivery, inProgress: true }) : null;
  };
  const initial = mode === 'background' && timeoutSeconds ? null : await read();
  if (initial !== null) return initial;
  const pending = (status: 'timeout' | 'cancelled') =>
    saveResponse({
      status,
      inProgress: true,
      successful: false,
      phase: 'save',
      operationId,
    });
  if (!timeoutSeconds) return pending('timeout');
  if (signal?.aborted) return pending('cancelled');
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waker: ReturnType<typeof boardWaker> | undefined;
  try {
    return await new Promise<ReturnType<typeof saveResponse>>((resolve, reject) => {
      waker = boardWait
        ? boardWaker(boardWait, delivery =>
            resolve(saveResponse({ status: 'message', board: delivery, inProgress: true })),
          )
        : undefined;
      timer = setTimeout(() => resolve(stoppedSource() ?? pending('timeout')), timeoutSeconds * 1000);
      stop = () => resolve(pending('cancelled'));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedSaves:progress'),
        { projectId: transport.address.projectId, operationId, ...boardArgs },
        value => {
          try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            const done = terminal(parsed);
            if (done) resolve(done);
            else waker?.offer(parsed);
          } catch (error) {
            reject(error);
          }
        },
        error => {
          const failure = hostedActionError(error, 'save observation');
          if (!registering(failure)) reject(failure);
        },
      );
    });
  } finally {
    waker?.stop();
    clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}

/** wait on a landing that has not been submitted yet (source preparation outlived land's budget):
 * replay the original finish by its operationId within this wait's budget, which never submits
 * twice, then wait on the submission it reaches. So land and finish hand out the same `wait`
 * continuation as every other landing step. Calls: the replay's own, plus the ordinary wait. */
async function continueFinish(
  transport: HostedAgentTransport,
  operationId: string,
  command: Record<string, unknown>,
  input: { operationIds: string[]; timeoutSeconds: number },
  signal: AbortSignal | undefined,
  emit: ((value: unknown) => void) | undefined,
  subscribe: () => HostedRunSubscription,
  board?: BoardWaitOption,
) {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  transport.waitUntil = deadline;
  const replayed = await transport.dispatch('finish', { ...command, operationId }, signal);
  const result = (replayed.result ?? {}) as Record<string, unknown>;
  const remaining = Math.max(0, (deadline - Date.now()) / 1000);
  if (result.phase === 'finish' && result.submission)
    return observeHostedSubmissions(
      transport,
      { ...input, timeoutSeconds: remaining },
      signal,
      emit,
      subscribe,
      board,
      landingFeedLanes(transport.root, [operationId]),
    );
  // A check-only finish that reserved its run: wait on that run, as land does.
  const run = result.run as { id?: unknown } | undefined;
  if (result.phase === 'check' && typeof run?.id === 'string')
    return observeHostedRun(
      transport,
      { runId: run.id, timeoutSeconds: remaining },
      signal,
      emit,
      subscribe,
      board,
    );
  // Source still running (not retryable or failed, which carry their own recovery): the same wait resumes it.
  const preparing = preparingFinishSource(result);
  return response({
    ...result,
    status: preparing ? 'timeout' : 'terminal',
    operationId,
  });
}

/** After an operation-id wait fails with NOT_FOUND: the server has no landing for the id. A check-only
 * finish (its run, or a clear terminal answer when it produced none) and a save follow what this
 * client recorded for the id, instead of failing forever. undefined when the id is not a recorded
 * local operation, so the caller rethrows its original error. */
export async function followLocalOperation(
  transport: HostedAgentTransport,
  root: string,
  input: { operationIds: string[]; timeoutSeconds: number },
  error: unknown,
  signal?: AbortSignal,
  emit?: (value: unknown) => void,
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(transport.address),
  board?: BoardWaitOption,
) {
  if (hostedActionError(error, 'observation').code !== 'NOT_FOUND' || input.operationIds.length !== 1)
    return undefined;
  const operationId = input.operationIds[0]!,
    local = localOperation(root, operationId);
  // Saves and reverts can outlive the local journal. Check their exact project and operation
  // records on this NOT_FOUND path without replaying either action.
  if (!local)
    return (
      (await observeHostedSave(
        transport,
        operationId,
        input.timeoutSeconds,
        signal,
        subscribe,
        board,
        'unrecorded',
      )) ?? observeHostedRevert(transport, operationId, input.timeoutSeconds, signal, board)
    );
  if (local.kind === 'check-run')
    return observeHostedRun(
      transport,
      { runId: local.runId, timeoutSeconds: input.timeoutSeconds },
      signal,
      emit,
      subscribe,
      board,
    ).catch(error => {
      // This wait was registered under the local finish id, not the hosted run id.
      if (error instanceof ForgeError && error.code === 'SOURCE_AUTHORITY_CHANGED' && error.recovery)
        settleTurnWork([operationId]);
      throw error;
    });
  if (local.kind === 'save')
    return observeHostedSave(transport, operationId, input.timeoutSeconds, signal, subscribe, board);
  if (local.kind === 'finish')
    return continueFinish(transport, operationId, local.command, input, signal, emit, subscribe, board);
  return response({
    status: 'terminal',
    successful: false,
    phase: 'check-only',
    operationId,
    reason:
      'This check-only operation produced no check run (the Lane had nothing new to check), so there is nothing to wait for.',
    next: 'Save new changes, then run land --check-only again for a fresh check.',
  });
}

/** Wait on operation ids: a hosted landing as before, else the local operation it names. */
export function landingFeedLanes(root: string, operationIds: string[]) {
  const lanes = new Set<string>();
  const agent = join(clientCacheRoot(hostedAgentRoot(root)), 'agent');
  for (const operationId of operationIds) {
    if (!z.uuid().safeParse(operationId).success || !checkoutPathExists(join(agent, `${operationId}.json`)))
      return undefined;
    const retained = retainedHostedOperation(root, operationId);
    if (retained?.action !== 'finish') return undefined;
    const { command } = retained;
    const inputs = command.inputs as { laneId?: unknown }[] | undefined;
    // Candidate/compose replays without retained inputs may select a different Lane than ROOT.
    const laneId =
      inputs?.[0]?.laneId ??
      command.laneId ??
      (command.composeOperationId || command.candidateId ? undefined : markerIdentity(root)?.laneId);
    const lane = z.uuid().safeParse(laneId);
    if (!lane.success) return undefined;
    lanes.add(lane.data);
  }
  return [...lanes];
}

export async function observeOperations(
  transport: HostedAgentTransport,
  root: string,
  input: {
    operationIds: string[];
    timeoutSeconds: number;
    [key: string]: unknown;
  },
  signal?: AbortSignal,
  emit?: (value: unknown) => void,
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(transport.address),
  board?: BoardWaitOption,
) {
  try {
    return await observeHostedSubmissions(
      transport,
      input,
      signal,
      emit,
      subscribe,
      board,
      input.until === 'acceptance' ? landingFeedLanes(root, input.operationIds) : undefined,
    );
  } catch (error) {
    const followed = await followLocalOperation(
      transport,
      root,
      input,
      error,
      signal,
      emit,
      subscribe,
      board,
    );
    if (followed) return followed;
    // Name where the wait looked: an id from another project's folder is NOT_FOUND here (ad80e037).
    const failure = hostedActionError(error, 'observation');
    if (failure.code === 'NOT_FOUND')
      throw new ForgeError(
        'NOT_FOUND',
        `${failure.message} This wait looked in the project of ${root}; run it from the Lane or project folder that started the operation.`,
        failure.retryAt,
        failure.recovery,
      );
    throw error;
  }
}
