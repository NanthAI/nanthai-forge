// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { AutonomyPolicy } from './autonomy-policy.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';

type PolicyPort = Pick<HostedAgentSession, 'query' | 'mutation'>;

/** `policy` is one query. `set-policy` is one mutation that merges the given fields; the original
 * operationId replays the recorded change (same fields) instead of applying it again. */
export async function executeHostedPolicy(
  port: PolicyPort,
  action: 'policy' | 'set-policy',
  command: Record<string, unknown>,
  operationId?: string,
): Promise<{ operationId: string | null; result: unknown; retiredPolicyFields?: string[] }> {
  if (action === 'policy') {
    const result = await port.query<AutonomyPolicy>('projectAutonomy:read', {});
    // Keep result usable as set-policy's expectedPolicy, including the compatibility value.
    return {
      operationId: null,
      result,
      ...(result.agentDefaults?.overlapGate === undefined
        ? {}
        : { retiredPolicyFields: ['agentDefaults.overlapGate'] }),
    };
  }
  const id = operationId ?? randomUUID();
  const result = await port.mutation('projectAutonomy:set', {
    command: JSON.stringify({ action: 'set-policy', operationId: id, ...command }),
  });
  return { operationId: id, result };
}
