// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './shell-quote.js';
import type { ForgeError } from './errors.js';
import type { HostedAgentAddress, HostedAgentAction } from './hosted-agent-contract.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';

/** Unknown transport outcomes never start a new attempt. Before a journal is
 * selected there has been no write: retain that exact shorthand for discovery. */
export function networkContinuation(
  root: string,
  address: HostedAgentAddress,
  action: HostedAgentAction,
  input: Record<string, unknown>,
  operationId: string | null,
  error: Pick<ForgeError, 'code' | 'message'> & { recovery?: Record<string, unknown> | undefined },
): HostedAgentResponse {
  const parameters = { ...input, ...(operationId ? { operationId } : {}) };
  const next = { ...parameters, action };
  return {
    schema: 1,
    transport: 'hosted',
    action,
    operationId,
    resolved: operationId ? { operationId } : null,
    result: {
      status: 'in-progress',
      phase: 'transport',
      inProgress: true,
      successful: false,
      // A 429/503 refusal keeps retryable and retryAt (72d50375).
      error: {
        code: error.code,
        message: error.message,
        ...(error.recovery ? { recovery: error.recovery } : {}),
      },
      replayParameters: parameters,
      next,
      command: `nforge agent ${shellQuote(root)} ${action} ${shellQuote(JSON.stringify({ ...address, ...parameters }))}`,
    },
  };
}
export function isNetworkPending(response: HostedAgentResponse) {
  const result = response.result as { phase?: string; inProgress?: boolean } | null;
  return result?.phase === 'transport' && result.inProgress === true;
}
