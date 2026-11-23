// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// No-carry hold (Item 1018d0f8, decision c2be3da5): a plain change does not start its Lane check
// while a spent order-sensitive holder at the head of the order is checking; the check starts when
// that holder leaves. Incident 0e94a117 (dogfood 2026-11-22): a schema change re-checked after newer
// entries had spent its overtake step, and the plain changes that arrived meanwhile were checked on
// the old main and thrown away as `order-sensitive` when it landed.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { storedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { noCarryHold, waitFootprints } from '../src/landing-overtake';
import { preQueueCheck } from '../src/hosted-landing-admission';
import { landingChangedPaths } from './projectHostedLandingOvertake';
import { closeOrderWait, holdsLandingOrder } from './projectHostedLandingOrder';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import { loadLanding, loadLandingAttempt, writeLanding } from './projectHostedLandingStore';
import { startLandingAdmission } from './projectHostedLandingAdmission';
import { retireSoloCheck } from './projectHostedLandingStaleChecks';
import { hostedStartMain } from './projectHostedChannels';
import { loadFinish } from './projectHostedFinishStore';
import { heldCommand } from './projectHostedLandingEnvironmentHold';
import { landingQueue, wakeLandingQueue } from './projectHostedLandingEvents';

type LandingRow = Doc<'projectHostedLandingRequests'>;
export type NoCarryRelease = 'holder-landed' | 'holder-exit' | 'claim';

/** FORGE_QUEUE_NO_CARRY_HOLD=1 turns the hold on. Off by default; deleted once the dogfood read in
 * Item 1018d0f8 decides (Done-when "Measured"). */
export const noCarryHoldOn = () => process.env.FORGE_QUEUE_NO_CARRY_HOLD === '1';

/** The adaptive-setting declaration (docs/agents/briefings.md, automatic settings). */
export const NO_CARRY_HOLD_SETTING = {
  setting: 'server switch FORGE_QUEUE_NO_CARRY_HOLD',
  default: 'off (rollout); automatic once the dogfood read accepts it',
  signal:
    "The queue's own rows at submit: the oldest entry that holds order, its phase, its spent overtake step (`overtaken`), its changed paths, and whether an older entry is still in its Lane check.",
  formula:
    'Hold when noCarryHold(mine, theirs) is true for the head-of-order entry (checking, step spent, its own order-sensitive risk the only link, the new change without risk of its own) and no older entry is admitting; release on that entry exit.',
  bounds:
    'Holds a change at most until one holder leaves the order (lands, fails, is withdrawn or stops holding order); never holds an urgent change, a change with its own risk, a stacked or re-landing change, or a change whose paths are unknown; a held change keeps its stall alarm, so a lost release falls back to the plain queue.',
  override:
    'FORGE_QUEUE_NO_CARRY_HOLD unset or not 1 turns it off (every change starts its Lane check at submit, as before). Manual mode hint: "Automatic would hold this check because submission X is re-checking its own order-sensitive change and lands first."',
  reason:
    'A Lane check started behind a spent order-sensitive holder is thrown away when that holder lands (incident 0e94a117): about 3 to 4.5 of 32.5 discarded runner-minutes per landing on dogfood.',
  judgedOn:
    'The shared flow measure (landings that stay landed, save-to-main time); discarded runner-minutes per landing and the count of held checks are guards, not goals.',
  touches: [
    'bounded overtaking and the risk-only step (43b51a5e)',
    'combined pre-queue checks and cohort holds (10b0a94b)',
    'pre-queue Lane checks (admissionCheck full)',
    'main-move stale-check sweep and solo retire (retireSoloCheck)',
    'keep the run (FORGE_QUEUE_KEEP_THE_RUN, fa2c1383)',
  ],
} as const;

/** Older live entries read per submit: the same window the order claim reads. */
const NO_CARRY_WINDOW = 16;

/** The head-of-order entry this new change must not start its Lane check behind, or null (Item
 * 1018d0f8). Reads nothing while the switch is off or the paths are unknown. Otherwise the oldest
 * order-live row (one read; a page of at most 16 only when that one no longer holds order). Only
 * when the head of the order is checking with its step spent: one index read (an older entry still
 * in its Lane check can land first, so nothing is held) and one Candidate read for its paths. */
export async function noCarryHolder(
  ctx: MutationCtx,
  mine: {
    projectId: Id<'hostedProjects'>;
    channel: LandingRow['channel'];
    sequence: number;
    priority?: 'urgent' | 'normal';
    paths: readonly string[] | null;
  },
  project: Pick<Doc<'hostedProjects'>, 'checkEntries' | 'globalRiskPaths'> | null,
  now = Date.now(),
) {
  if (!noCarryHoldOn() || mine.priority === 'urgent' || !mine.paths?.length || !project?.checkEntries)
    return null;
  const olderLive = (limit: number) =>
    ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_orderLive_and_sequence', q =>
        q
          .eq('projectId', mine.projectId)
          .eq('channel', mine.channel)
          .eq('orderLive', true)
          .lt('sequence', mine.sequence),
      )
      .order('asc')
      .take(limit);
  let older = await olderLive(1);
  const first = older[0];
  if (first && !holdsLandingOrder(first, storedLandingStateSchema.parse(JSON.parse(first.value)), now))
    older = await olderLive(NO_CARRY_WINDOW);
  for (const head of older) {
    const value = storedLandingStateSchema.parse(JSON.parse(head.value));
    if (!holdsLandingOrder(head, value, now)) continue;
    // Only the head of the order: anything behind it lands after it, never before.
    if (head.phase !== 'checking' || head.overtaken === undefined) return null;
    const target = {
      phase: head.phase,
      priority: head.priority,
      attemptId: head.attemptId,
      runId: head.runId ?? null,
      admitted: Boolean(head.admission?.full && head.admission.status === 'passed' && !head.admission.reuse),
      overtaken: head.overtaken,
      parked: Boolean(head.orderWait),
    };
    // An older change still in its Lane check holds no order yet but can land first.
    const [admitting] = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_admitting_and_sequence', q =>
        q
          .eq('projectId', mine.projectId)
          .eq('channel', mine.channel)
          .eq('admitting', true)
          .lt('sequence', head.sequence),
      )
      .take(1);
    if (admitting) return null;
    const checkEntries = [...project.checkEntries, ...(project.globalRiskPaths ?? [])];
    const theirs = await landingChangedPaths(ctx, head, value);
    return noCarryHold(mine.paths, theirs, checkEntries, target)
      ? { row: head, footprints: waitFootprints(mine.paths, theirs, checkEntries) }
      : null;
  }
  return null;
}

/** Held changes started per release mutation: each starts a Lane check (about as much work as a
 * submit), so a page stays small; a full page reschedules the next. */
const NO_CARRY_PAGE = 8;

/** The holder left the order (`wakeLandingOrderWaiters`, on its land, failure or withdraw; never on a
 * baton or a re-pin). In the holder's own transaction, which nothing here can fail: each held change
 * gets its stall alarm back (if this release never runs, the stall repair queues it as an ordinary
 * entry), and one release mutation is scheduled. That mutation starts their Lane checks after the
 * holder's exit committed, so it sees the main that exit published (a batch publishes the Channel
 * after its members' writes). */
export async function scheduleNoCarryRelease(
  ctx: MutationCtx,
  holder: Pick<LandingRow, 'projectId' | 'submissionId'>,
  held: readonly LandingRow[],
  cause: 'holder-landed' | 'holder-exit',
) {
  for (const waiter of held)
    if (!waiter.alarm)
      await ctx.db.patch(waiter._id, {
        alarm: await armLandingAlarm(
          ctx,
          waiter,
          hostedLandingProgressAt(storedLandingStateSchema.parse(JSON.parse(waiter.value))),
        ),
      });
  await scheduleRelease(ctx, holder.projectId, holder.submissionId, cause);
}

const scheduleRelease = (
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
  cause: 'holder-landed' | 'holder-exit',
  after?: number,
) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLandingNoCarry:release'), {
    projectId,
    submissionId,
    release: cause,
    ...(after === undefined ? {} : { after }),
  });

/** Start the Lane checks of the changes held behind `submissionId`, oldest first, one page per
 * mutation. Unconditional: a holder back in the order (a main-red park and recovery) re-holds
 * nothing, so nothing waits on an exit that may not wake again. */
export const release = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    release: v.union(v.literal('holder-landed'), v.literal('holder-exit')),
    after: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const waiters = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_orderWait_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .eq('orderWait', input.submissionId)
          .gt('sequence', input.after ?? -1),
      )
      .order('asc')
      .take(NO_CARRY_PAGE);
    for (const waiter of waiters) await releaseNoCarryWaiter(ctx, waiter, input.release);
    if (waiters.length === NO_CARRY_PAGE)
      await scheduleRelease(
        ctx,
        input.projectId,
        input.submissionId,
        input.release,
        waiters.at(-1)!.sequence,
      );
    return null;
  },
});

/** One held change becomes an ordinary arrival on the main of this moment: on unchanged main it
 * starts its Lane check on its existing Candidate; on a moved main it recomposes there and its
 * replacement runs, as the main-move sweep's solo retire does; otherwise (CI down, no Lane check
 * configured, a finish step in flight) it joins the queue as a submit without its Lane check does.
 * The urgent path calls it in the priority change's own transaction. Returns whether it released. */
export async function releaseNoCarryWaiter(ctx: MutationCtx, waiter: LandingRow, cause: NoCarryRelease) {
  if (!waiter.noCarryWait || waiter.phase !== 'queued') return false;
  const { row: held, state } = await loadLanding(ctx, {
    projectId: waiter.projectId,
    submissionId: waiter.submissionId,
  });
  if (!held.noCarryWait || state.phase !== 'queued') return false;
  await ctx.db.patch(held._id, {
    orderWait: undefined,
    noCarryWait: undefined,
    ...closeOrderWait(held, Date.now(), false, cause),
  });
  const row = (await ctx.db.get(held._id))!;
  const attempt = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const main = await hostedStartMain(ctx, row.projectId);
  const queue = await landingQueue(ctx, { projectId: row.projectId, channel: row.channel });
  const sameMain = attempt.main.head === main.head && attempt.main.receiptId === main.receipt.id;
  if (sameMain && !heldCommand(queue?.ciDown, state.request)) {
    const runId = await startLandingAdmission(ctx, {
      projectId: row.projectId,
      attempt,
      request: state.request,
    });
    if (runId) {
      const admission = {
        runId,
        status: 'checking' as const,
        ...(preQueueCheck(attempt.policy) ? { full: true as const } : {}),
      };
      await ctx.db.patch(row._id, { admission, admitting: true, batchable: false });
      await writeLanding(
        ctx,
        { ...row, admission, admitting: true, batchable: false },
        {
          ...state,
          version: state.version + 1,
          phase: 'checking',
          observation: landingObservation('checking'),
          error: null,
        },
        false,
        false,
      );
      return true;
    }
  }
  if (!sameMain && state.request.finish) {
    const finish = await loadFinish(ctx, { projectId: row.projectId, submissionId: row.submissionId });
    if (!finish.value.pending) {
      await retireSoloCheck(ctx, { row, state, attempt, finish, main });
      return true;
    }
  }
  await writeLanding(ctx, row, { ...state, version: state.version + 1 }, true);
  await wakeLandingQueue(ctx, { projectId: row.projectId, channel: row.channel });
  return true;
}
