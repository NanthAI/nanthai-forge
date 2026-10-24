// SPDX-License-Identifier: Apache-2.0
import { ConvexClient } from 'convex/browser';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { z } from 'zod';
import { resolveAuthToken } from './auth-store.js';
import { hostedCheckStatusSchema, hostedCheckTerminal } from './hosted-check.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

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
export function hostedRunSubscription(address: HostedAgentAddress): HostedRunSubscription {
  const token = resolveAuthToken(address.url, process.env.FORGE_AUTH_TOKEN);
  invariant(token, 'AUTH_REQUIRED', 'Run nforge login or supply your current Forge sign-in token.');
  const client = new ConvexClient(address.url, { logger: false, unsavedChangesWarning: false });
  client.setAuth(async () => token);
  return client;
}
const runSchema = z.object({ id: z.uuid(), projectId: z.string(), status: hostedCheckStatusSchema });
/** Only an explicit active wait creates a live client. No polling, hydration or worker wake. */
export async function observeHostedRun(
  transport: HostedAgentTransport,
  input: unknown,
  signal?: AbortSignal,
  emit: (value: unknown) => void = () => {},
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(transport.address),
) {
  const command = hostedRunWaitSchema.parse(input);
  const initial = await transport.dispatch('observe', { runId: command.runId });
  function run(value: unknown) {
    value = typeof value === 'string' ? JSON.parse(value) : value;
    const parsed = runSchema.safeParse(value);
    invariant(
      parsed.success &&
        parsed.data.id === command.runId &&
        parsed.data.projectId === transport.address.projectId,
      'HOSTED_PROTOCOL_INVALID',
      'Run observation differs from the selected project/run.',
    );
    return { value, terminal: hostedCheckTerminal(parsed.data) };
  }
  let latest = initial.result;
  let terminal = run(latest).terminal;
  const result = (status: 'terminal' | 'timeout' | 'cancelled') => ({
    ...initial,
    result: { status, run: latest },
  });
  emit(latest);
  if (terminal) return result('terminal');
  if (signal?.aborted) return result('cancelled');
  if (!command.timeoutSeconds) return result('timeout');
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    return await new Promise<ReturnType<typeof result>>((resolve, reject) => {
      const end = performance.now() + command.timeoutSeconds * 1000;
      const expire = () => {
        const remaining = end - performance.now();
        if (remaining <= 0) resolve(result('timeout'));
        else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      };
      expire();
      stop = () => resolve(result('cancelled'));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedCheckRead:status'),
        { projectId: transport.address.projectId, runId: command.runId },
        value => {
          try {
            const next = run(value);
            latest = next.value;
            terminal = next.terminal;
            emit(latest);
            if (terminal) resolve(result('terminal'));
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
    if (timer) clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}

export const hostedWaitSchema = z
  .object({
    runId: z.uuid().optional(),
    operationIds: z.array(z.uuid()).optional(),
    cursor: z.string().nullable().optional(),
    until: z.enum(['terminal', 'any-change']).optional(),
    timeoutSeconds: z.number().nonnegative().finite().optional(),
  })
  .strict();
