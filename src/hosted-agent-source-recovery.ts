// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { normalizeObservedFinish, withFinishLandingState } from './hosted-agent-finish-result.js';
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
    // Conflict recovery owns its own exact sync continuation.
    if (key === 'recovery' && (reply.recovery as Reply | undefined)?.operationId) continue;
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
  const finish = action === 'finish' && !!value && typeof value === 'object';
  const submission = (value as { submission?: { error?: { code?: string } } } | null)?.submission;
  const parameters = command as Reply;
  const cancelledLane =
    finish && submission?.error?.code === 'LANDING_CANCELLED' && typeof parameters.laneId !== 'string'
      ? session.marker()?.selection.laneId
      : undefined;
  const selection = cancelledLane ? { ...parameters, laneId: cancelledLane } : parameters;
  // Additive `landingState` on every finish reply that carries a submission (Issue 68361cd5).
  const landing = (reply: unknown) => (finish ? withFinishLandingState(selection, reply as Reply) : reply);
  if (finish) {
    const normalized = normalizeObservedFinish(session.root, selection, value as Reply);
    if (normalized !== value) return landing(normalized);
  }
  const source = sourceReply(value);
  if (!source) return landing(value);
  if ((source.error as { code?: string } | undefined)?.code === 'SOURCE_STATE_TOO_LARGE')
    return landing(value);
  const replay = { action, ...session.address, ...command, operationId: session.journal.operationId };
  const next = {
    action,
    ...command,
    operationId:
      source.status === 'failed'
        ? await session.journal.id('source-failure-next')
        : session.journal.operationId,
  };
  return landing({
    ...(value as object),
    status: source.status,
    ...(source.error ? { error: source.error, failedPhase: source.failedPhase ?? `source-${action}` } : {}),
    replay: { ...replay, command: hostedRecoveryCommand(session.root, action, replay) },
    next,
    command: hostedRecoveryCommand(session.root, action, { ...replay, operationId: next.operationId }),
  });
}
