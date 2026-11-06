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
import { hostedActionError } from './hosted-action-error.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import {
  observeHostedRun,
  hostedRunSubscription,
  type HostedRunSubscription,
} from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import type { BoardWaitOption } from './hosted-board-wait.js';

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
    if ((request && !request.channel) || context?.command?.accept === false) return { kind: 'check-only' };
    // A landing whose source preparation has not reached submission yet.
    const retained = retainedHostedOperation(base, operationId);
    if (retained?.action === 'finish') return { kind: 'finish', command: retained.command };
  }
  if (existsSync(join(clientCacheRoot(base), 'saves', operationId))) return { kind: 'save' };
  return undefined;
}

const progressSchema = z.object({
  terminal: z
    .object({
      outcome: z.object({ status: z.string(), result: z.unknown().optional() }),
    })
    .nullable()
    .optional(),
});
const response = (result: Record<string, unknown>) => ({
  schema: 1 as const,
  transport: 'hosted' as const,
  action: 'observe' as const,
  operationId: null,
  resolved: null,
  result,
});

/** Wait on a save operation by its id: terminal as soon as the server's save record is, via one
 * live query for the length of the wait. No polling and no marker write (preflight and finish
 * reconcile the checkout from the same original operation). */
async function observeHostedSave(
  transport: HostedAgentTransport,
  operationId: string,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  subscribe: () => HostedRunSubscription,
) {
  const terminal = (value: unknown) => {
    const outcome = progressSchema.parse(value).terminal?.outcome;
    if (!outcome) return null;
    const result = outcome.result as { head?: string; sourceVersion?: number } | undefined;
    return response({
      status: 'terminal',
      successful: outcome.status === 'completed',
      phase: 'save',
      operationId,
      outcome: outcome.status,
      ...(result?.head ? { head: result.head, sourceVersion: result.sourceVersion } : {}),
      next: 'Run preflight or land: they settle the checkout from this original save without repeating it.',
    });
  };
  const read = async () => {
    try {
      return terminal(await transport.query('projectHostedSaves:progress', { operationId }));
    } catch (error) {
      if (hostedActionError(error, 'save observation').code !== 'NOT_FOUND') throw error;
      return response({
        status: 'terminal',
        successful: false,
        phase: 'save',
        operationId,
        reason: 'The server has no record of this save yet. Replay the original save with this operationId.',
      });
    }
  };
  const initial = await read();
  if (initial) return initial;
  const pending = (status: 'timeout' | 'cancelled') =>
    response({
      status,
      inProgress: true,
      successful: false,
      phase: 'save',
      operationId,
    });
  if (!timeoutSeconds) return pending('timeout');
  if (signal?.aborted) return pending('cancelled');
  const client = subscribe();
  let release = () => {};
  try {
    return await new Promise<ReturnType<typeof response>>((resolve, reject) => {
      const timer = setTimeout(() => settle(pending('timeout')), timeoutSeconds * 1000);
      const stop = () => settle(pending('cancelled'));
      const unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedSaves:progress'),
        { projectId: transport.address.projectId, operationId },
        value => {
          try {
            const done = terminal(typeof value === 'string' ? JSON.parse(value) : value);
            if (done) settle(done);
          } catch (error) {
            release();
            reject(error);
          }
        },
        error => {
          release();
          reject(hostedActionError(error, 'save observation'));
        },
      );
      release = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        unsubscribe();
      };
      function settle(value: ReturnType<typeof response>) {
        release();
        resolve(value);
      }
      signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    release();
    await client.close();
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
) {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  transport.waitUntil = deadline;
  const replayed = await transport.dispatch('finish', { ...command, operationId }, signal);
  const result = (replayed.result ?? {}) as Record<string, unknown>;
  if (result.phase === 'finish' && result.submission)
    return observeHostedSubmissions(
      transport,
      { ...input, timeoutSeconds: Math.max(0, (deadline - Date.now()) / 1000) },
      signal,
      emit,
      subscribe,
    );
  // Source still running (not retryable or failed, which carry their own recovery): the same wait resumes it.
  const preparing =
    ['save', 'compose', 'sync'].includes(String(result.phase)) && result.status === 'submitted';
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
) {
  if (hostedActionError(error, 'observation').code !== 'NOT_FOUND' || input.operationIds.length !== 1)
    return undefined;
  const operationId = input.operationIds[0]!,
    local = localOperation(root, operationId);
  if (!local) return undefined;
  if (local.kind === 'check-run')
    return observeHostedRun(
      transport,
      { runId: local.runId, timeoutSeconds: input.timeoutSeconds },
      signal,
      emit,
      subscribe,
    );
  if (local.kind === 'save')
    return observeHostedSave(transport, operationId, input.timeoutSeconds, signal, subscribe);
  if (local.kind === 'finish')
    return continueFinish(transport, operationId, local.command, input, signal, emit, subscribe);
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
    return await observeHostedSubmissions(transport, input, signal, emit, subscribe, board);
  } catch (error) {
    const followed = await followLocalOperation(transport, root, input, error, signal, emit, subscribe);
    if (followed) return followed;
    throw error;
  }
}
