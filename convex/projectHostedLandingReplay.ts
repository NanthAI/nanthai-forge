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
const cause = v.object({
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
    // No writer named the cause; the link is the stop code, so the gap stays countable.
    v.literal('unknown'),
  ),
  link: v.string(),
});
export type ReplayCause = Infer<typeof cause>;
export const landingReplay = v.object({
  check: v.optional(check),
  earlierChecks: v.optional(v.array(check)),
  actualBase: v.optional(base),
  censor: v.optional(v.string()),
  replacementCause: v.optional(cause),
  replacedByAttemptId: v.optional(v.string()),
  recheckCause: v.optional(cause),
  // Stamped on the landed attempt when its receipt lists no order waits. Older landings omit it.
  holdEdges: v.optional(v.literal('none')),
});
export type LandingReplay = Infer<typeof landingReplay>;

/** The cause of a replacement whose writer named none, from the evidence in hand at that write
 * (Item ced8e98f): the successor's own pins and the stop code, never dates. */
export function replacementCauseOf(input: {
  code: string;
  nextMain: { receiptId: string } | undefined;
  successor: Pick<HostedLandingAttempt, 'candidate' | 'check'> | undefined;
}): ReplayCause {
  const { code, nextMain, successor } = input;
  if (successor && successor.candidate.head === null)
    return { kind: 'conflict', link: successor.candidate.id };
  if (code === 'CHANNEL_CHANGED' && nextMain) return { kind: 'main-race', link: nextMain.receiptId };
  if (successor?.check) return { kind: 'check-binding', link: successor.check.runId };
  return { kind: 'unknown', link: code };
}

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

/** Hold edges from the receipt's order waits. `none` needs the landed attempt's stamp, so a
 * receipt written before the stamp reads `unrecorded`, never an invented "no hold". */
export function replayHoldEdges(
  waits: readonly { submissionId: string; held: string; footprints: string; seconds?: number }[] | undefined,
  replays: readonly (LandingReplay | undefined)[] = [],
) {
  if (!waits?.length) return replays.some(replay => replay?.holdEdges === 'none') ? 'none' : 'unrecorded';
  return waits.map(({ submissionId, held, footprints, seconds }) => ({
    holderSubmissionId: submissionId,
    edgeType: held === 'dependent' ? 'dependent' : footprints === 'unknown' ? 'unrecorded' : footprints,
    heldSeconds: seconds ?? 'unrecorded',
  }));
}
