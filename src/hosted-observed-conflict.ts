// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import type { HostedLandingState } from './hosted-landing.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** A landing read whose submission ended in a composition conflict and carries no recovery yet. */
export function terminalConflict(
  value: unknown,
): value is { submission: HostedLandingState; recovery?: unknown; conflict?: unknown } {
  const entry = value as
    | {
        submission?: { phase?: string; observation?: { state?: string }; error?: { code?: string } | null };
        recovery?: unknown;
        conflict?: unknown;
      }
    | null
    | undefined;
  const state = entry?.submission?.observation?.state ?? entry?.submission?.phase;
  return (
    state === 'terminal-failed' &&
    entry?.submission?.error?.code === 'COMPOSITION_CONFLICT' &&
    !entry.recovery &&
    !entry.conflict
  );
}
/** Observation must retain the rejected attempt, which can differ from the
 * originally submitted Candidate after recomposition or batching. No source IO
 * or recovery mutation belongs in a wait; sync owns preparation and resolve. */
export async function observedConflictRecovery<
  T extends { submission: HostedLandingState; recovery?: unknown; conflict?: unknown },
>(transport: Pick<HostedAgentTransport, 'root' | 'address' | 'query'>, entry: T) {
  const { submission } = entry;
  if (submission.error?.code !== 'COMPOSITION_CONFLICT' || entry.recovery || entry.conflict) return entry;
  const status = z
    .object({
      request: z.object({ id: z.uuid(), attemptId: z.uuid() }),
      attempt: z.object({ id: z.uuid(), candidate: z.object({ id: z.uuid() }).passthrough() }),
    })
    .parse(await transport.query('projectHostedLanding:status', { submissionId: submission.id }));
  invariant(
    status.request.id === submission.id &&
      status.request.attemptId === submission.attemptId &&
      status.attempt.id === submission.attemptId,
    'HOSTED_PROTOCOL_INVALID',
    'Conflict recovery differs from the observed submission/attempt.',
  );
  const candidate = status.attempt.candidate;
  // Bound native roots have no hosted checkout marker; keep routing explicit.
  const command = { ...transport.address, candidateId: candidate.id };
  const next = { action: 'sync', candidateId: candidate.id };
  return {
    ...entry,
    recovery: {
      conflict: {
        candidateId: candidate.id,
        candidate,
        error: submission.error,
        next,
        command: hostedRecoveryCommand(transport.root, 'sync', command),
      },
    },
  };
}
