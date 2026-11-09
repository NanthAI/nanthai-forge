// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { markerIdentity } from './lane-prune.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { parseHostedResponse } from './hosted-response.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

type ApprovalPort = {
  root: string;
  query<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  agentSlug(): string | undefined;
};
export type ApprovalCommand = { laneId?: string; reason?: string; withdraw?: boolean };

/**
 * `request-approval` (Issue fe5bea80): ask the project owner for a go on one saved Lane, with a
 * reason the owner and the board see. One mutation, no capability discovery; the operationId
 * (generated when omitted, printed in the reply) makes a lost reply's retry return the same request.
 * `withdraw:true` drops your own request. Agents can request, never grant.
 */
export async function executeHostedApproval(
  port: ApprovalPort,
  command: ApprovalCommand,
  operationId?: string,
): Promise<{ operationId: string | null; result: unknown }> {
  const laneId = command.laneId ?? markerIdentity(port.root)?.laneId;
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId, or run request-approval from the Lane checkout.');
  if (command.withdraw)
    return {
      operationId: null,
      result: await port.mutation('projectHostedApprovals:withdraw', { laneId }),
    };
  invariant(command.reason, 'BAD_ARGUMENT', 'request-approval needs a reason the owner can read.');
  const id = operationId ?? randomUUID();
  const agent = port.agentSlug();
  const result = await port.mutation('projectHostedApprovals:request', {
    operationId: id,
    laneId,
    reason: command.reason,
    ...(agent ? { agent } : {}),
  });
  return { operationId: id, result };
}

const decisionSchema = z.looseObject({
  laneId: z.string(),
  status: z.enum(['none', 'requested', 'granted', 'declined']),
  version: z.number(),
});
export type ApprovalOutcome = {
  status: 'decided' | 'none' | 'timeout' | 'cancelled';
  approval: z.infer<typeof decisionSchema> | null;
};
/** Replaceable in tests; production subscribes with the live Convex client. */
export const approvalWaitHooks: {
  subscribe?: (address: HostedAgentTransport['address']) => HostedRunSubscription;
} = {};

/**
 * `wait {approval: LANE_ID}`: ONE live subscription to projectHostedApprovals:observe (one indexed
 * row) for the length of the wait. It re-runs only when the owner grants or declines (or the request
 * is reopened or withdrawn), and returns on that write. No polling; nothing after the process exits.
 */
export async function observeApproval(
  transport: Pick<HostedAgentTransport, 'address'>,
  input: { laneId: string; timeoutSeconds: number },
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () =>
    (approvalWaitHooks.subscribe ?? hostedRunSubscription)(transport.address),
): Promise<ApprovalOutcome> {
  let latest: ApprovalOutcome['approval'] = null;
  if (signal?.aborted) return { status: 'cancelled', approval: latest };
  const client = subscribe();
  let release = () => {};
  try {
    return await new Promise<ApprovalOutcome>((resolve, reject) => {
      const settle = (value: ApprovalOutcome) => {
        release();
        resolve(value);
      };
      const timer = setTimeout(
        () => settle({ status: 'timeout', approval: latest }),
        Math.max(0, input.timeoutSeconds * 1000),
      );
      const stop = () => settle({ status: 'cancelled', approval: latest });
      const unsubscribe = client.onUpdate(
        makeFunctionReference<'query'>('projectHostedApprovals:observe'),
        { projectId: transport.address.projectId, laneId: input.laneId },
        value => {
          try {
            const parsed = parseHostedResponse(
              decisionSchema,
              typeof value === 'string' ? JSON.parse(value) : value,
            );
            latest = parsed;
            if (parsed.status === 'granted' || parsed.status === 'declined')
              settle({ status: 'decided', approval: parsed });
            else if (parsed.status === 'none') settle({ status: 'none', approval: parsed });
          } catch (error) {
            release();
            reject(
              error instanceof z.ZodError || error instanceof SyntaxError
                ? new ForgeError('HOSTED_PROTOCOL_INVALID', 'Approval observation is invalid.')
                : error,
            );
          }
        },
        error => {
          release();
          reject(hostedActionError(error, 'approval observation'));
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

/** The wait's one-line next step for each outcome. */
export function approvalNext(outcome: ApprovalOutcome, laneId: string) {
  const lane = laneId.slice(0, 8);
  if (outcome.status === 'none') return `Lane ${lane} has no approval request. Ask with request-approval.`;
  if (outcome.status !== 'decided') return null;
  return outcome.approval?.status === 'granted'
    ? `The owner granted Lane ${lane}. Land it now (land --save); a new save after the grant needs the owner again.`
    : `The owner declined Lane ${lane}. Read their reason, address it in this Lane, then request-approval again.`;
}
