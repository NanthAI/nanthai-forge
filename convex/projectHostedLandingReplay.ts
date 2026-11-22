// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { hostedCheckClock } from './projectHostedCheckClock';

const base = v.object({ head: v.string(), receiptId: v.string() });
const check = v.object({
  runId: v.string(),
  // Omit when the check uses the immutable attempt's own base.
  predictedBase: v.optional(base),
  dispatchedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  recordedEndAt: v.optional(v.string()),
  stop: v.optional(v.literal('CHECK_CANCELLED')),
});
export const replayCause = v.object({
  kind: v.union(
    v.literal('main-race'),
    v.literal('conflict'),
    v.literal('pair-interaction'),
    v.literal('policy'),
    v.literal('flake-retry'),
    v.literal('provider-retry'),
    v.literal('audit'),
    // The queue bound a check (an admission proof, a deferred or cohort check) without recomposing: no recheck.
    v.literal('check-binding'),
    // A new save of the author's Lane superseded the entry; the link is the saved Lane head.
    v.literal('new-save'),
    // An operator, the author, a lifecycle or an owner decline ended the entry and nothing replaced
    // it; the link names that path.
    v.literal('cancelled'),
    // The writer knows no cause; the link names the writer and its stop code, so the gap stays countable.
    v.literal('unknown'),
  ),
  link: v.string(),
});
export type ReplayCause = Infer<typeof replayCause>;
export const landingReplay = v.object({
  check: v.optional(check),
  earlierChecks: v.optional(v.array(check)),
  actualBase: v.optional(base),
  censor: v.optional(v.string()),
  replacementCause: v.optional(replayCause),
  replacedByAttemptId: v.optional(v.string()),
  recheckCause: v.optional(replayCause),
  // Stamped on the landed attempt: `none` when its receipt lists no order waits, `recorded` when
  // each listed wait has its edge type. Landings before the stamp omit it.
  holdEdges: v.optional(v.union(v.literal('none'), v.literal('recorded'))),
});
export type LandingReplay = Infer<typeof landingReplay>;

export function checkReplay(run: HostedCheckRun): LandingReplay {
  const clock = hostedCheckClock(run);
  const dispatchedAt = clock?.dispatchedAt ?? run.actions?.reservedAt;
  return {
    check: {
      runId: run.id,
      predictedBase: run.candidate.base,
      ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
      ...(clock?.startedAt === undefined ? {} : { startedAt: clock.startedAt }),
      ...(clock?.endedAt === undefined ? {} : { endedAt: clock.endedAt }),
      ...(run.endedAt ? { recordedEndAt: run.endedAt } : {}),
      ...(run.status === 'cancelled' ? { stop: 'CHECK_CANCELLED' } : {}),
    },
  };
}

export function replayRead(
  attempt: Pick<HostedLandingAttempt, 'number' | 'main'>,
  replay: LandingReplay | undefined,
  phase: HostedLandingState['phase'] | undefined,
) {
  const unrecorded = 'unrecorded' as const;
  const check = replay?.check;
  const dispatch = check?.dispatchedAt;
  const start = check?.startedAt;
  return {
    attempt: attempt.number,
    composedBase: attempt.main,
    runId: check?.runId ?? unrecorded,
    ...(replay?.earlierChecks?.length
      ? {
          earlierChecks: replay.earlierChecks.map(check => ({
            ...check,
            predictedBase: check.predictedBase ?? attempt.main,
          })),
        }
      : {}),
    predictedBase: check ? (check.predictedBase ?? attempt.main) : unrecorded,
    actualBase:
      replay?.actualBase ??
      (replay && (phase === 'landed' || replay.replacedByAttemptId) ? attempt.main : unrecorded),
    dispatchedAt: dispatch === undefined ? unrecorded : new Date(dispatch).toISOString(),
    startedAt: start === undefined ? unrecorded : new Date(start).toISOString(),
    endedAt: check?.endedAt === undefined ? unrecorded : new Date(check.endedAt).toISOString(),
    recordedEndAt: check?.recordedEndAt ?? unrecorded,
    waitedToStartMs:
      start !== undefined && dispatch !== undefined && start >= dispatch ? start - dispatch : unrecorded,
    outcome: replay?.censor
      ? 'censored'
      : replay && phase === 'landed'
        ? 'landed'
        : replay && phase === 'terminal-failed'
          ? 'failed'
          : unrecorded,
    censorReason: replay?.censor ?? unrecorded,
    replacementCause: replay?.replacementCause ?? unrecorded,
    replacedByAttemptId: replay?.replacedByAttemptId ?? unrecorded,
    recheckCause: replay?.recheckCause ?? unrecorded,
  };
}

/** Hold edges from the request's claim waits and handoffs (`landingOrderEvidence`). Overlap or
 * disjoint footprints are the edge type; a wait whose footprints were never read (an
 * approved-check, combined, handed or reserved hold) is typed by its hold kind. `none` needs the
 * landed attempt's stamp and a hold-kind type needs the `recorded` one, so a receipt written
 * before either reads `unrecorded`, never an invented answer. */
export function replayHoldEdges(
  waits:
    | readonly { submissionId: string; held: string; footprints: string; seconds?: number }[]
    | null
    | undefined,
  replays: readonly (LandingReplay | undefined)[] = [],
) {
  const stamp = replays.find(replay => replay?.holdEdges)?.holdEdges;
  if (!waits?.length) return stamp ? 'none' : 'unrecorded';
  return waits.map(({ submissionId, held, footprints, seconds }) => ({
    holderSubmissionId: submissionId,
    edgeType:
      held === 'dependent'
        ? 'dependent'
        : footprints !== 'unknown'
          ? footprints
          : stamp === 'recorded'
            ? held
            : 'unrecorded',
    heldSeconds: seconds ?? 'unrecorded',
  }));
}
