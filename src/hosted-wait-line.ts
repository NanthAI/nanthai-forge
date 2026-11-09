// SPDX-License-Identifier: Apache-2.0
import { landingHold } from './hosted-landing-hold.js';
import { landingStateOf, type LandingRecord } from './landing-state.js';
type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const defined = (value: Json): Json =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

/**
 * One observation event as the line a waiting agent reads (Issue 47558a99). The full event repeats the
 * whole submission, queue and resume cursor on every wake (31k-70k tokens per 50 s drain while queued);
 * the line keeps what an agent decides on: phase, queue position and terminal outcome. The final response
 * still carries the complete submission and the cursor. `key` ignores clocks and versions, so a wake that
 * changed nothing prints nothing.
 */
export function waitEventLine(event: unknown): { line: Json; key: string } | undefined {
  const e = obj(event);
  if (e.type === 'submission') {
    const submission = obj(e.submission),
      observation = obj(submission.observation),
      queue = obj(e.queue),
      error = obj(submission.error);
    const line = defined({
      type: 'submission',
      operationId: e.operationId,
      phase: submission.phase,
      state: observation.state,
      reason: observation.pendingReason ?? undefined,
      position: queue.position,
      ahead: queue.entriesAhead,
      total: queue.total,
      // Advice and recovery are what an agent acts on: kept whole when present, absent otherwise.
      wouldConflict: e.wouldConflict ?? undefined,
      // A passed entry parked behind an older submission names it (19328518).
      waitingFor: obj(e.orderWait).submissionId ?? undefined,
      recovery: e.recovery ?? e.conflict ?? undefined,
      error: error.code,
      // Held for a person or a dependency (5c59940b): the reason (protected paths) and next step.
      hold: landingHold(submission as Parameters<typeof landingHold>[0]) ?? undefined,
      // The shared state name (src/landing-state.ts); the line stays compact, so the word and next
      // step ride on the full reply (and a hold's next step on `hold`).
      landingState: e.submission ? landingStateOf(submission as LandingRecord).state : undefined,
      terminal: e.terminal,
      ok: e.ok,
    });
    return { line: { ...line, version: submission.version }, key: JSON.stringify(line) };
  }
  // Check-run snapshots, input pages, retry notes: top-level scalars only, no project echo or request body.
  const line = Object.fromEntries(
    Object.entries(e).filter(
      ([key, v]) => scalar(v) && !['projectId', 'request', 'cursor', 'at'].includes(key),
    ),
  );
  if (!Object.keys(line).length) return undefined;
  return { line: { type: 'run', ...line }, key: JSON.stringify(line) };
}
