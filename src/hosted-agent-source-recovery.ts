// SPDX-License-Identifier: Apache-2.0
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';

type Reply = Record<string, unknown>;
function sourceReply(value: unknown): Reply | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as Reply;
  if (reply.jobId && ['submitted', 'retryable', 'failed'].includes(String(reply.status))) return reply;
  const outcome = reply.outcome as { status?: string; error?: { code?: string } } | undefined;
  if (outcome?.status === 'failed' && outcome.error?.code) return { status: 'failed', error: outcome.error };
  for (const key of ['progress', 'source', 'recovery']) {
    const found = sourceReply(reply[key]);
    if (found) return found;
  }
  return null;
}
/** Retain the public action's identity, including a finish/resolve child phase.
 * A retryable step replays that action; a terminal receipt stays immutable. */
export async function withSourceRecovery(
  session: HostedAgentSession,
  action: string,
  command: object,
  value: unknown,
) {
  const source = sourceReply(value);
  if (!source) return value;
  const replay = { action, ...session.address, ...command, operationId: session.journal.operationId };
  const next =
    source.status === 'failed'
      ? { ...replay, operationId: await session.journal.id('source-failure-next') }
      : replay;
  return {
    ...(value as object),
    status: source.status,
    ...(source.error ? { error: source.error, failedPhase: source.failedPhase ?? `source-${action}` } : {}),
    replay: { ...replay, command: hostedRecoveryCommand(session.root, action, replay) },
    next,
    command: hostedRecoveryCommand(session.root, action, next),
  };
}
