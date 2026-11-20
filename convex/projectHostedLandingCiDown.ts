// SPDX-License-Identifier: Apache-2.0
// Incident e62d834b, line 5 (2026-11-20 05:27-06:41Z): every landing check ended RUNNER_UNAVAILABLE,
// so each landing spent its platform retries on a broken CI and failed for good, and every builder
// had to land again once CI recovered. The CI-down hold (switch FORGE_QUEUE_HOLD_ON_CI_DOWN, off by
// default: queue-regression guard) reads the failure-cause classification the platform retries already
// use. Once CI_DOWN_STREAK landing checks in a row end on one infrastructure cause with no verdict
// between, an entry whose check ends that way parks under the `ci-down` hold with one reason instead of
// retrying and failing. One probe wake per backoff step lets one held entry check again; the first
// verdict (a pass or a failing test) anywhere in the queue ends the hold and releases the rest.
// Healthy path: no reads and no writes (the queue row is already in hand, and `ciDown` is unset).
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { checkFailureKind, HOSTED_PLATFORM_RETRIES } from '../src/hosted-landing-admission';
import { checkInfrastructure } from '../src/check-run-state';
import { cancelPendingTask } from './schedulerCancel';
import { landingQueue } from './projectHostedLandingEvents';
import { releaseHeldPage } from './projectHostedMainAuditState';
import { withQueueStatusBatch } from './projectHostedQueueStatusWrite';
import { leaveTrain, parkEntry, parkableOrigin, type ParkAs } from './projectHostedLandingParkExact';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { writeBatch, type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchStore';
import { settleBatchConflicts } from './projectHostedLandingCohortConflicts';
import type { LandingRow } from './projectHostedLandingStore';

export const holdOnCiDown = () => process.env.FORGE_QUEUE_HOLD_ON_CI_DOWN === '1';
/** Consecutive infrastructure ends, on one cause and with no verdict between, that trip the hold. One
 * more than the platform retries, so a lone entry's or cohort's last retry trips it at the latest
 * (review 2bf14e44 N2: lowering the retries lowers the streak with them). */
export const CI_DOWN_STREAK = HOSTED_PLATFORM_RETRIES + 1;
/** Probe backoff: one held entry checks again after each step; the last step repeats. */
export const CI_DOWN_PROBE_MS = [2, 4, 8, 15, 30].map(minutes => minutes * 60_000);
/** Held pages a probe may skip (entries that ended while held) before it gives up for this step. */
const PROBE_PAGES = 10;

type Queue = Doc<'projectHostedLandingQueues'>;
export type CiDown = NonNullable<Queue['ciDown']>;
type Entry = { row: LandingRow; state: HostedLandingState };

/** An infrastructure end, read as the platform retries read it: CI stopped or never started the check,
 * no test failed and nobody cancelled it. */
export const infraEnd = (run: HostedCheckRun) =>
  checkInfrastructure(run.status) &&
  !run.cancelRequested &&
  run.counts.failed === 0 &&
  checkFailureKind(run, { conflicts: [] }) === 'platform';
export const ciDownTripped = (ciDown: CiDown | undefined | null) => (ciDown?.streak ?? 0) >= CI_DOWN_STREAK;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** The one reason every held entry, the queue and `wait` show. */
export const ciDownMessage = (ciDown: CiDown) =>
  `CI is failing for every check: the last ${ciDown.streak} landing checks ended without a verdict (latest: ${ciDown.cause})${
    ciDown.reason ? ` (${clip(ciDown.reason, 200)})` : ''
  } since ${new Date(ciDown.since).toISOString()}. Not this change: it waits and checks again once CI runs checks again; no action needed.`;
const parkAs = (ciDown: CiDown): ParkAs => ({
  hold: 'ci-down',
  error: { code: 'CI_DOWN', message: ciDownMessage(ciDown) },
});

const probeRef = makeFunctionReference<'mutation'>('projectHostedLandingCiDown:probe');
const releaseRef = makeFunctionReference<'mutation'>('projectHostedLandingCiDown:release');
async function armProbe(ctx: MutationCtx, projectId: Id<'hostedProjects'>, next: CiDown, now: number) {
  const delay = CI_DOWN_PROBE_MS[Math.min(next.probes ?? 0, CI_DOWN_PROBE_MS.length - 1)]!;
  next.probeAt = now + delay;
  next.wakeId = await ctx.scheduler.runAfter(delay, probeRef, { projectId });
}

/** Records one infrastructure end on the queue row in hand (one patch, failure path only) and says
 * whether CI is down: the streak reached CI_DOWN_STREAK on one cause. Tripping arms the first probe.
 * Once tripped, an infrastructure end on any cause extends the hold with its probe (a runner that dies
 * mid-run ends interrupted, none at all runner-unavailable): restarting the streak would leave the held
 * entries with no probe and a verdict that releases nothing (review 2bf14e44 B1). */
export async function noteInfraEnd(ctx: MutationCtx, queue: Queue, run: HostedCheckRun, now = Date.now()) {
  const prev = queue.ciDown;
  const kept = prev && (prev.cause === run.status || ciDownTripped(prev)) ? prev : undefined;
  if (prev?.wakeId && !kept) await cancelPendingTask(ctx, prev.wakeId);
  const next: CiDown = {
    cause: run.status,
    since: kept ? kept.since : now,
    streak: kept ? kept.streak + 1 : 1,
    ...(run.failureReason ? { reason: clip(run.failureReason, 300) } : {}),
    ...(kept?.probes ? { probes: kept.probes } : {}),
    ...(kept?.wakeId ? { wakeId: kept.wakeId, probeAt: kept.probeAt } : {}),
  };
  const down = ciDownTripped(next);
  if (down && !next.wakeId) await armProbe(ctx, queue.projectId, next, now);
  await ctx.db.patch(queue._id, { ciDown: next });
  queue.ciDown = next;
  return down;
}

/** A landing check reached a verdict, so CI runs checks: the streak ends, and a tripped hold releases
 * every held entry in scheduled pages. Nothing to do (no read, no write) when `ciDown` is unset. Not
 * gated on the switch, so turning it off still drains what it held. */
export async function clearCiDown(ctx: MutationCtx, queue: Queue | null | undefined) {
  const prev = queue?.ciDown;
  if (!queue || !prev) return;
  await cancelPendingTask(ctx, prev.wakeId);
  await ctx.db.patch(queue._id, { ciDown: undefined });
  queue.ciDown = undefined;
  if (ciDownTripped(prev)) await ctx.scheduler.runAfter(0, releaseRef, { projectId: queue.projectId });
}

/** One entry's own exact check ended on infrastructure: records it, and while CI is down parks the
 * entry with a fresh deferred attempt instead of its platform retry. False when the hold does not
 * apply (switch off, not an infrastructure end, CI not down, or a check its submission never deferred),
 * so the caller's platform retry runs as before. */
export async function holdSoloForCiDown(
  ctx: MutationCtx,
  claim: { projectId: Id<'hostedProjects'> },
  entry: Entry & { attempt: HostedLandingAttempt },
  run: HostedCheckRun,
  queue: Queue | null | undefined,
) {
  if (!holdOnCiDown() || !queue || !infraEnd(run)) return false;
  if (!(await noteInfraEnd(ctx, queue, run))) return false;
  const origin = await parkableOrigin(ctx, claim, entry);
  if (!origin) return false;
  await parkEntry(ctx, entry, run, origin.own, parkAs(queue.ciDown!));
  await leaveTrain(ctx, [entry]);
  if (origin.line) await advanceBatchFallback(ctx, origin.line.key, origin.line.batch);
  return true;
}

/** A cohort's shared check ended on infrastructure: records it, and while CI is down ends the cohort
 * and parks every pending member on its own deferred original instead of the cohort's platform retry
 * (no member goes solo). False when the hold does not apply; the caller retries as before. */
export async function holdBatchForCiDown(
  ctx: MutationCtx,
  key: BatchIdentity,
  batch: LandingBatch,
  run: HostedCheckRun,
  pendingMembers: () => Promise<(Entry & { original: HostedLandingAttempt })[]>,
) {
  if (!holdOnCiDown() || !infraEnd(run)) return false;
  const queue = await landingQueue(ctx, { projectId: key.projectId, channel: 'main' });
  if (!queue || !(await noteInfraEnd(ctx, queue, run))) return false;
  const as = parkAs(queue.ciDown!);
  const pending = await pendingMembers();
  await writeBatch(ctx, key, { ...batch, phase: 'failed', transition: as.error });
  if (batch.included) await settleBatchConflicts(ctx, key, { ...batch, phase: 'failed' });
  for (const member of pending) await parkEntry(ctx, member, run, member.original, as);
  if (pending.length) await leaveTrain(ctx, pending);
  return true;
}

/** The redrive sweep's backstop for a held row: a hold that ended (its release page was lost) releases
 * again, and a tripped hold with no armed probe gets one. True when something was (or, with `act`
 * false, would be) re-driven. One queue-row read. */
export async function redriveCiDown(ctx: MutationCtx, projectId: Id<'hostedProjects'>, act: boolean) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (!queue) return false;
  if (!ciDownTripped(queue.ciDown)) {
    if (act) await ctx.scheduler.runAfter(0, releaseRef, { projectId });
    return true;
  }
  const wakeId = queue.ciDown!.wakeId;
  const wake = wakeId ? await ctx.db.system.get(wakeId) : null;
  if (wake?.state.kind === 'pending' || wake?.state.kind === 'inProgress') return false;
  if (act) {
    const next = { ...queue.ciDown! };
    await armProbe(ctx, projectId, next, Date.now());
    await ctx.db.patch(queue._id, { ciDown: next });
  }
  return true;
}
/** Releases the held entries once the hold ended, 25 a page under one queue-status flush. A hold that
 * tripped again meanwhile keeps them: its probe owns them. */
export const release = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const queue = await landingQueue(ctx, { projectId, channel: 'main' });
    if (ciDownTripped(queue?.ciDown)) return null;
    await withQueueStatusBatch(ctx, async () => {
      const page = await releaseHeldPage(ctx, projectId, 'ci-down', 25, false);
      if (!page.isDone) await ctx.scheduler.runAfter(0, releaseRef, { projectId });
    });
    return null;
  },
});

/** The probe: one held entry checks again, and the next probe is armed one backoff step later. Its
 * verdict ends the hold (clearCiDown cancels the next probe); another infrastructure end parks it
 * again. With nothing held the hold ends here, and the next infrastructure end starts a new streak. */
export const probe = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const queue = await landingQueue(ctx, { projectId, channel: 'main' });
    const ciDown = queue?.ciDown;
    if (!queue || !ciDown) return null;
    let released = false,
      done = false;
    await withQueueStatusBatch(ctx, async () => {
      for (let page = 0; page < PROBE_PAGES && !released && !done; page++)
        ({ released, isDone: done } = await releaseHeldPage(ctx, projectId, 'ci-down', 1, false));
    });
    // Nothing is held any more: the hold ends. Pages of only ended entries left: probe again later.
    if (!released && done) {
      await ctx.db.patch(queue._id, { ciDown: undefined });
      return null;
    }
    const { wakeId: _wake, probeAt: _at, ...rest } = ciDown;
    void [_wake, _at];
    const next: CiDown = { ...rest, probes: (ciDown.probes ?? 0) + 1 };
    await armProbe(ctx, projectId, next, Date.now());
    await ctx.db.patch(queue._id, { ciDown: next });
    return null;
  },
});
