// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import type { AutonomyPolicy } from './autonomy-policy.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { setupLesson } from './error-teaching.js';

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
  const result = await port.mutation<Record<string, unknown>>('projectAutonomy:set', {
    command: JSON.stringify({ action: 'set-policy', operationId: id, ...command }),
  });
  if (result.rule !== 'held') return { operationId: id, result };
  const acceptance = command.acceptance as Partial<AutonomyPolicy['acceptance']> | undefined;
  const section = command.deploys
    ? '7-tell-forge-where-you-deploy'
    : acceptance?.protectedPaths !== undefined || acceptance?.ownerApprovalPaths !== undefined
      ? '5-choose-paths-that-need-a-person'
      : acceptance?.mode !== undefined
        ? '4-choose-who-approves-landings'
        : 'what-an-agent-can-and-cant-do';
  return { operationId: id, result: { ...result, learn: setupLesson(section) } };
}
