// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
import { retryableExchangeError } from './exchange-retry.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** Settling normally ends well inside this; only a quiet Ready entry is asked about. */
export const redriveQuietMs = 2 * 60_000;
const redriveQuietMaxMs = 15 * 60_000;
const pausedWaitMaxMs = 5 * 60_000;

/** Issue 72d50375: a write outage can make an entry's scheduled settlement step
 * fail, and Convex does not retry it. The observe subscription stays free of
 * that check (reading wake state there re-runs it on every reschedule). Instead
 * a waiting reader whose entry stays Ready with no new version for a quiet
 * period asks Forge once to re-drive lost steps; Forge finds them, and a healthy
 * entry gets back an empty list. Asks back off (2, 4, 8, 15 min) while the
 * entry stays quiet, follow a pause's retry time, and stop with the wait. No
 * waiter, no asks: an idle queue costs nothing. */
export function landingRedriver(
  transport: Pick<HostedAgentTransport, 'mutation'>,
  stopped: () => boolean,
  quietMs = redriveQuietMs,
) {
  const watched = new Map<string, { version: number; timer?: ReturnType<typeof setTimeout> }>();
  const live = (id: string, version: number) => watched.get(id)?.version === version && !stopped();
  const arm = (id: string, version: number, delay: number, quiet: number) => {
    const entry = watched.get(id);
    if (!entry || !live(id, version)) return;
    entry.timer = setTimeout(() => void ask(id, version, quiet), delay);
    entry.timer.unref?.();
  };
  const ask = async (id: string, version: number, quiet: number) => {
    if (!live(id, version)) return;
    const next = Math.min(redriveQuietMaxMs, quiet * 2);
    try {
      await transport.mutation('projectHostedLandingRedrive:redrive', { submissionId: id });
      arm(id, version, next, next);
    } catch (failure) {
      // Anything else leaves the entry to its stall alarm and lead tools.
      const error = retryableExchangeError(hostedActionError(failure, 'landing re-drive'));
      if (!error) return;
      const until = (error.retryAt ?? 0) - Date.now();
      arm(id, version, until > 0 ? Math.min(pausedWaitMaxMs, until + 1_000) : quiet, quiet);
    }
  };
  /** Call with every observed page; a new version or phase restarts the quiet period. */
  return (submission: { id: string; version: number; phase: string; observation: { state: string } }) => {
    const settling = submission.phase === 'ready' && submission.observation.state === 'pending';
    const entry = watched.get(submission.id);
    if (settling && entry?.version === submission.version) return;
    if (entry?.timer) clearTimeout(entry.timer);
    watched.delete(submission.id);
    if (!settling) return;
    watched.set(submission.id, { version: submission.version });
    arm(submission.id, submission.version, quietMs, quietMs);
  };
}
