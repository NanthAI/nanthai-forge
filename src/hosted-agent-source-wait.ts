// SPDX-License-Identifier: Apache-2.0
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
/** Only an active recovery call subscribes to its exact source operation. The
 * durable worker continues after a deadline/disconnect; no polling or redispatch. */
export async function waitHostedAgentSource(
  address: HostedAgentAddress,
  operationId: string,
  initial: unknown,
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(address),
  kind: 'Sync' | 'Saves' | 'Compose' = 'Sync',
) {
  initial = sourceWaitSnapshot(initial);
  if (stopped(initial)) return initial;
  if (signal?.aborted) return initial;
  let latest = initial;
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => resolve(sourceWaitSnapshot(latest)), 60_000);
      stop = () => resolve(sourceWaitSnapshot(latest));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>(`projectHosted${kind}:progress`),
        { projectId: address.projectId, operationId },
        value => {
          try {
            const progress = typeof value === 'string' ? JSON.parse(value) : value;
            const observed = sourceWaitSnapshot(progress);
            if (stopped(observed)) resolve(observed);
            else if (progress?.jobId) latest = observed;
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
