// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { HostedAgentSession } from './hosted-agent-transport.js';

type PolicyPort = Pick<HostedAgentSession, 'query' | 'mutation'>;

/** `policy` is one query. `set-policy` is one mutation that merges the given fields; the original
 * operationId replays the recorded change (same fields) instead of applying it again. */
export async function executeHostedPolicy(
  port: PolicyPort,
  action: 'policy' | 'set-policy',
  command: Record<string, unknown>,
  operationId?: string,
): Promise<{ operationId: string | null; result: unknown }> {
  if (action === 'policy') return { operationId: null, result: await port.query('projectAutonomy:read', {}) };
  const id = operationId ?? randomUUID();
  const result = await port.mutation('projectAutonomy:set', {
    command: JSON.stringify({ action: 'set-policy', operationId: id, ...command }),
  });
  return { operationId: id, result };
}
