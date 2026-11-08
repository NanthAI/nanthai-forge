// SPDX-License-Identifier: Apache-2.0
import { sourceWaitSnapshot } from './hosted-agent-source-wait.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';

const submitted = (value: unknown) => {
  const reply = value as { status?: unknown; jobId?: unknown } | null;
  return reply?.status === 'submitted' && typeof reply.jobId === 'string';
};

/** A check-only finish has no server-side continuation (a landing's desired request composes on the
 * server), so it settles its own compose before it reserves the check run (Issue 17cce1b3). A submit
 * action that already published the compose replies `{terminal, state}` (source-run-publish): that
 * terminal is the outcome, at zero calls. A job still running is followed on its one progress
 * subscription for the rest of the caller's budget; no polling and no replay. Returns the outcome,
 * or the pending snapshot when the budget ends first (the receipt's wait resumes it). */
export async function settleCheckOnlyCompose(
  session: HostedAgentSession,
  operationId: string,
  progress: unknown,
) {
  const snapshot = sourceWaitSnapshot(progress);
  const remaining = (session.waitUntil - Date.now()) / 1000;
  if (!submitted(snapshot) || remaining <= 0) return snapshot;
  try {
    return await session.waitSource(operationId, progress, 'Compose', remaining);
  } catch {
    // The compose is already submitted: an unavailable subscription leaves it pending, never failed.
    return snapshot;
  }
}
