// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
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
  if (initial && typeof initial === 'object' && 'outcome' in initial) return initial;
  if (signal?.aborted) return initial;
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => resolve(initial), 60_000);
      stop = () => resolve(initial);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>(`projectHosted${kind}:progress`),
        { projectId: address.projectId, operationId },
        value => {
          try {
            const progress = typeof value === 'string' ? JSON.parse(value) : value;
            if (progress?.terminal) resolve(progress.terminal);
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
