// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { parseHostedResponse } from './hosted-response.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

const mainSchema = z.object({
  main: z.looseObject({
    state: z.enum(['green', 'red', 'pending', 'unreported']),
    since: z.string().optional(),
  }),
});
export type MainWaitOutcome = {
  status: 'green' | 'unreported' | 'timeout' | 'cancelled';
  main: z.infer<typeof mainSchema>['main'] | null;
};
/** Replaceable in tests; production subscribes with the live Convex client. */
export const mainWaitHooks: {
  subscribe?: (address: HostedAgentTransport['address']) => HostedRunSubscription;
} = {};

/**
 * `wait {"main":"green"}` (friction 1e94d000): returns once main's newest audit passes, at once when it
 * already has, and at once when main has no audit yet (`unreported`, said, never called green).
 * ONE live subscription to projectBoardWait:main (main's audit row) for the length of the wait; it
 * re-runs only when that row changes. No polling, nothing after the process exits.
 */
export async function observeMainGreen(
  transport: Pick<HostedAgentTransport, 'address'>,
  input: { timeoutSeconds: number },
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () =>
    (mainWaitHooks.subscribe ?? hostedRunSubscription)(transport.address),
): Promise<MainWaitOutcome> {
  let latest: MainWaitOutcome['main'] = null;
  if (signal?.aborted) return { status: 'cancelled', main: latest };
  const client = subscribe();
  let release = () => {};
  try {
    return await new Promise<MainWaitOutcome>((resolve, reject) => {
      const settle = (value: MainWaitOutcome) => {
        release();
        resolve(value);
      };
      const timer = setTimeout(
        () => settle({ status: 'timeout', main: latest }),
        Math.max(0, input.timeoutSeconds * 1000),
      );
      const stop = () => settle({ status: 'cancelled', main: latest });
      const unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectBoardWait:main'),
        { projectId: transport.address.projectId },
        value => {
          try {
            latest = parseHostedResponse(
              mainSchema,
              typeof value === 'string' ? JSON.parse(value) : value,
            ).main;
            if (latest.state === 'green' || latest.state === 'unreported')
              settle({ status: latest.state, main: latest });
          } catch (error) {
            release();
            reject(
              error instanceof z.ZodError || error instanceof SyntaxError
                ? new ForgeError('HOSTED_PROTOCOL_INVALID', 'Main observation is invalid.')
                : error,
            );
          }
        },
        error => {
          release();
          reject(hostedActionError(error, 'main observation'));
        },
      );
      release = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        unsubscribe();
        release = () => {};
      };
      signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    release();
    await client.close();
  }
}

/** The wait's reply body for each outcome; the same words in the CLI and MCP. */
export function mainWaitResult(outcome: MainWaitOutcome, budgetSeconds: number, resume: object) {
  if (outcome.status === 'unreported')
    return {
      status: 'terminal',
      reason: 'main',
      main: outcome.main,
      next: 'Main has no full audit yet, so Forge cannot say it is red or green; nothing to wait for. Read the failed landing’s failureCause before landing again.',
    };
  return outcome.status === 'green'
    ? {
        status: 'terminal',
        reason: 'main',
        main: outcome.main,
        next: 'Main is green. Land any change that failed only on main’s red again now (land --save in its Lane).',
      }
    : {
        status: 'IN_PROGRESS',
        reason: outcome.status === 'timeout' ? 'budget' : outcome.status,
        budgetSeconds,
        main: outcome.main,
        ...resume,
      };
}
