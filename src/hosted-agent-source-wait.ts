// SPDX-License-Identifier: Apache-2.0
import { retryHostedObservation } from './hosted-observation-retry.js';
import { makeFunctionReference } from 'convex/server';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
/** Compact the public observation without retaining source inputs in a pending reply.
 * A live query does not tick when wall time alone crosses a lease deadline. */
export function sourceWaitSnapshot(value: unknown, now = Date.now()): unknown {
  if (!value || typeof value !== 'object') return value;
  const progress = value as Record<string, unknown>;
  if (progress.terminal) return progress.terminal;
  const source = progress.source as { status?: string; phase?: string; workerUntil?: number } | undefined;
  if (!progress.jobId || !source) return value;
  const expired =
    ['running', 'dispatching', 'completed'].includes(String(source.status)) &&
    typeof source.workerUntil === 'number' &&
    source.workerUntil <= now;
  return {
    status: expired && progress.status === 'submitted' ? 'retryable' : progress.status,
    jobId: progress.jobId,
    source,
    ...(progress.error
      ? { error: progress.error, failedPhase: progress.failedPhase }
      : expired
        ? {
            error: {
              code: source.status === 'completed' ? 'SOURCE_PUBLICATION_STALLED' : 'SOURCE_JOB_STALLED',
              message:
                'The source operation made no progress before its lease deadline. Replay the original operation to reconcile the retained execution or output.',
            },
            failedPhase: source.phase,
          }
        : {}),
  };
}
const stopped = (value: unknown) =>
  !!value &&
  typeof value === 'object' &&
  ('outcome' in value || ('status' in value && ['retryable', 'failed'].includes(String(value.status))));
/** A caller's own end condition on the raw progress: `value` resolves with it, `waitMs` keeps
 * waiting but resolves with the default snapshot once that long passes (armed once); undefined
 * keeps the default rule. */
export type SourceWaitSettle = (progress: unknown) => { value: unknown } | { waitMs: number } | undefined;
/** Only an active recovery call subscribes to its exact source operation. The
 * durable worker continues after a deadline/disconnect; no polling or redispatch. */
export async function waitHostedAgentSource(
  address: HostedAgentAddress,
  operationId: string,
  initial: unknown,
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(address),
  kind: 'Sync' | 'Saves' | 'Compose' = 'Sync',
  /** One subscription for the caller's whole budget (save waits for its own outcome). */
  timeoutSeconds = 60,
  /** Sees each raw progress value (the receipt reads its server timing); never changes the result. */
  observe?: (progress: unknown) => void,
  settle?: SourceWaitSettle,
) {
  let latest = initial;
  return retryHostedObservation({
    timeoutSeconds,
    signal,
    emit: event => process.stderr.write(`${JSON.stringify(event)}\n`),
    pending: () => sourceWaitSnapshot(latest),
    attempt: (_remaining, signal) =>
      waitHostedAgentSourceOnce(
        address,
        operationId,
        latest,
        signal,
        subscribe,
        kind,
        value => {
          latest = value;
        },
        observe,
        settle,
      ),
  });
}
async function waitHostedAgentSourceOnce(
  address: HostedAgentAddress,
  operationId: string,
  initial: unknown,
  signal: AbortSignal,
  subscribe: () => HostedRunSubscription,
  kind: 'Sync' | 'Saves' | 'Compose',
  remember: (value: unknown) => void,
  observe?: (progress: unknown) => void,
  settle?: SourceWaitSettle,
) {
  initial = sourceWaitSnapshot(initial);
  if (stopped(initial)) return initial;
  if (signal?.aborted) return initial;
  let latest = initial;
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      stop = () => resolve(sourceWaitSnapshot(latest));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>(`projectHosted${kind}:progress`),
        { projectId: address.projectId, operationId },
        value => {
          try {
            const progress = typeof value === 'string' ? JSON.parse(value) : value;
            observe?.(progress);
            const settled = settle?.(progress);
            if (settled && 'value' in settled) return resolve(settled.value);
            if (settled) {
              timer ??= setTimeout(() => resolve(sourceWaitSnapshot(progress)), settled.waitMs);
              return;
            }
            const observed = sourceWaitSnapshot(progress);
            if (stopped(observed)) resolve(observed);
            else if (progress?.jobId) {
              latest = observed;
              remember(observed);
            }
          } catch (error) {
            reject(error);
          }
        },
        error => reject(hostedActionError(error, 'conflict recovery')),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}
