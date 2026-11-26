// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { parseHostedResponse } from './hosted-response.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

const deployEntrySchema = z
  .looseObject({
    sequence: z.number(),
    head: z.string(),
    at: z.string(),
    runId: z.string(),
    url: z.string().optional(),
    status: z.enum(['succeeded', 'failed', 'smoke-failed']).optional(),
    summary: z.string().optional(),
    unchanged: z.literal(true).optional(),
    liveSequence: z.number().optional(),
    liveHead: z.string().optional(),
  })
  .nullable();

const deploySchema = z.object({
  deploy: z.looseObject({
    sequence: z.number(),
    receiptId: z.string().optional(),
    target: z.string().min(1),
    state: z.enum(['deployed', 'failed', 'pending']),
    deploys: z.record(z.string(), deployEntrySchema),
  }),
});

export type DeployWaitSelection =
  | string
  | {
      receiptId?: string | undefined;
      sequence?: number | undefined;
      target?: string | undefined;
    };

export type DeployWaitOutcome = {
  status: 'deployed' | 'failed' | 'timeout' | 'cancelled';
  deploy: z.infer<typeof deploySchema>['deploy'] | null;
};

/** Replaceable in tests; production subscribes with the live Convex client. */
export const deployWaitHooks: {
  subscribe?: (address: HostedAgentTransport['address']) => HostedRunSubscription;
} = {};

export function normalizeDeployWaitSelection(selection: DeployWaitSelection) {
  if (typeof selection === 'string') {
    if (selection === 'latest') return { target: 'all' as const };
    return { receiptId: selection, target: 'all' as const };
  }
  return {
    ...(selection.receiptId ? { receiptId: selection.receiptId } : {}),
    ...(selection.sequence !== undefined ? { sequence: selection.sequence } : {}),
    target: selection.target ?? ('all' as const),
  };
}

/**
 * `wait {"deploy": ...}` (Item 8b6efb50): returns once the selected landing (or current main) is
 * contained in a successful deploy (`deploy.sequence >= landing.sequence`), or immediately if a
 * deploy at/after that sequence failed. ONE live Convex subscription to `projectBoardWait:deploy`;
 * zero polling, zero idle cost.
 */
export async function observeDeploy(
  transport: Pick<HostedAgentTransport, 'address'>,
  input: { selection: DeployWaitSelection; timeoutSeconds: number },
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () =>
    (deployWaitHooks.subscribe ?? hostedRunSubscription)(transport.address),
): Promise<DeployWaitOutcome> {
  let latest: DeployWaitOutcome['deploy'] = null;
  if (signal?.aborted) return { status: 'cancelled', deploy: latest };
  const queryArgs = {
    projectId: transport.address.projectId,
    ...normalizeDeployWaitSelection(input.selection),
  };
  const client = subscribe();
  let release = () => {};
  try {
    return await new Promise<DeployWaitOutcome>((resolve, reject) => {
      const settle = (value: DeployWaitOutcome) => {
        release();
        resolve(value);
      };
      const timer = setTimeout(
        () => settle({ status: 'timeout', deploy: latest }),
        Math.max(0, input.timeoutSeconds * 1000),
      );
      const stop = () => settle({ status: 'cancelled', deploy: latest });
      const unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectBoardWait:deploy'),
        queryArgs,
        value => {
          try {
            latest = parseHostedResponse(
              deploySchema,
              typeof value === 'string' ? JSON.parse(value) : value,
            ).deploy;
            if (latest.state === 'deployed' || latest.state === 'failed')
              settle({ status: latest.state, deploy: latest });
          } catch (error) {
            release();
            reject(
              error instanceof z.ZodError || error instanceof SyntaxError
                ? new ForgeError('HOSTED_PROTOCOL_INVALID', 'Deploy observation is invalid.')
                : error,
            );
          }
        },
        error => {
          release();
          reject(hostedActionError(error, 'deploy observation'));
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

/** The wait's reply body for each outcome; shared by CLI and MCP. */
export function deployWaitResult(outcome: DeployWaitOutcome, budgetSeconds: number, resume: object) {
  if (outcome.status === 'deployed')
    return {
      status: 'terminal',
      reason: 'deploy',
      deploy: outcome.deploy,
      next: `Landing #${outcome.deploy?.sequence ?? ''} is live in the recorded deploy.`,
    };
  if (outcome.status === 'failed')
    return {
      status: 'terminal',
      reason: 'deploy-failed',
      deploy: outcome.deploy,
      next: 'The deploy or post-deploy smoke failed; inspect the recorded workflow URL and fix on main.',
    };
  return {
    status: 'IN_PROGRESS',
    reason: outcome.status === 'timeout' ? 'budget' : outcome.status,
    budgetSeconds,
    deploy: outcome.deploy,
    ...resume,
  };
}
