// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { wakeLandingQueue } from './projectHostedLandingEvents';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  hostedLandingAttemptSchema,
  hostedLandingStateSchema,
  type HostedLandingState,
} from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { armLandingAlarm } from './projectHostedLandingStallWake';
import { overtakeOlder } from '../src/landing-overtake';
import { HOSTED_ORDER_WAITS } from './projectHostedLandingOrder';
import {
  HOSTED_FINISH_COMPOSE_WATCHDOG_MS,
  HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS,
} from '../src/hosted-finish';
export const finishRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
/** Only pending work has a timer. Failed scheduling receipts can be repaired by
 * the original enqueue/resume; a running step retains its exact IO generation.
 * Item 9a04d916 (compose settle): a finish wake with no IO in flight is the settle
 * mutation, which Convex runs exactly once, not the drive action, which runs at most
 * once (a deploy can lose it, leaving the entry to its 15-minute stall alarm). A fresh
 * wake (new wake id) never has IO in flight: the step that submits a recompose, the one
 * that consumes a completed compose, the first step into acceptance, each next
 * acceptance page, a cohort's first compose step. A retained wake (the step's own IO
 * generation) stays the drive unless the caller names `settle` or `retry`. Any IO a
 * step needs still runs in the action, owned by the step's retained retry. Recovery
 * re-drives (stall supervisor, operator redrive) pass 'drive' and keep the action path. */
export async function scheduleFinish(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  delay = 0,
  retainId = false,
  settle: boolean | 'retry' | 'drive' = false,
  attempt?: number,
) {
  const kind =
    settle === 'drive' ? 'drive' : settle === 'retry' ? 'retry' : settle || !retainId ? 'settle' : 'drive';
  let task;
  if (row.wake && !retainId) {
    task = await ctx.db.system.get(row.wake.taskId);
    if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') return;
  }
  await cancelPendingTask(ctx, row.wake?.taskId, task);
  const id = retainId && row.wake ? row.wake.id : crypto.randomUUID();
  const taskId = await ctx.scheduler.runAfter(
    delay,
    kind === 'retry'
      ? makeFunctionReference<'mutation'>('projectHostedFinishDriver:retry')
      : kind === 'settle'
        ? makeFunctionReference<'mutation'>('projectHostedFinishDriver:settle')
        : makeFunctionReference<'action'>('projectHostedFinishDriver:drive'),
    {
      projectId: row.projectId,
      submissionId: row.submissionId,
      wakeId: id,
      ...(attempt ? { attempt } : {}),
    },
  );
  await ctx.db.patch(row._id, { wake: { id, taskId, at: Date.now() + delay } });
}
/** Mutation retries in a row between two drive steps (review d4f55e9f F2). */
export const FINISH_SETTLE_RETRIES = 3;
/** Review ba9ce962 L2: a step's retained IO retry, or a lease wait for its proof. It
 * owns the generation while the untracked IO runs, so it is the `retry` mutation (the
 * settle step, counted): the same one scheduler row, cancelled at resume. Its name is as
 * long as `drive` and the first retry carries no count, so a healthy step writes the same
 * bytes as a drive retry did. As a drive, a lost IO action and a lost retry action
 * together left the entry to its 15-minute stall alarm.
 *
 * The budget is FINISH_SETTLE_RETRIES mutation retries in a row, about 90 s, inside one
 * check wall. After it the retry is a drive, and that drive's own step starts the count
 * again (it carries none). A `wait` (a proof lease still held) is no loss: it keeps the
 * count instead of spending it, and ends with the lease. Why the restart cannot loop: IO
 * lost every time runs three mutations per drive retry, and the drive retry itself runs
 * every 30 s, as it did before compose settle. While that drive keeps arming the next
 * retry the entry is driven, and the supervisor never ends a queued entry something still
 * drives (projectHostedLandingStall.ts, "A queued entry ends only through the drop
 * repair"). A lost drive retry leaves no mutation behind, so the supervisor ends it typed
 * (LANDING_DRIVER_EXHAUSTED; test "IO lost every time spends the retry mutation budget"). */
export function retryFinish(
  ctx: MutationCtx,
  row: Doc<'projectHostedFinishes'>,
  input: { attempt?: number },
  delay = 30_000,
  wait = false,
) {
  const attempt = wait ? (input.attempt ?? 1) : (input.attempt ?? 0) + 1;
  if (attempt > FINISH_SETTLE_RETRIES) return scheduleFinish(ctx, row, delay, true);
  return scheduleFinish(ctx, row, delay, true, 'retry', attempt > 1 ? attempt : undefined);
}
/** Incident 2026-10-30: a source step action that threw (fetch failed) left its
 * compose running with no owner wake; the whole train waited for the 15-minute
 * stall alarm. The wake replays submit, whose lookup resumes the same step.
 * Review d4f55e9f F1: the watchdog step does no IO of its own (it reconciles the
 * compose, re-arms itself or exhausts), so it is the `retry` mutation: as a drive, a lost
 * source action and then a lost watchdog action left the entry to the stall alarm.
 * Cancelled when the compose completes. */
export async function watchFinishCompose(
  ctx: MutationCtx,
  rowId: Id<'projectHostedFinishes'>,
  startedAt: string,
  settle: () => Promise<void>,
) {
  const remaining = Date.parse(startedAt) + HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS - Date.now();
  const row = (await ctx.db.get(rowId))!;
  if (remaining <= 0) {
    await settle();
    return;
  }
  await scheduleFinish(ctx, row, Math.min(HOSTED_FINISH_COMPOSE_WATCHDOG_MS, remaining), false, 'retry');
}
export async function notifyFinish(ctx: MutationCtx, state: HostedLandingState) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  if (state.batchId && (state.phase === 'landed' || state.phase === 'terminal-failed')) {
    const batch = await ctx.db
      .query('projectHostedLandingBatches')
      .withIndex('by_project_and_batch', q => q.eq('projectId', projectId).eq('batchId', state.batchId!))
      .unique();
    if (batch && JSON.parse(batch.value).phase === 'fallback') {
      const leader = await finishRow(ctx, {
        projectId,
        submissionId: JSON.parse(batch.value).leaderId ?? state.batchId,
      });
      if (leader) await scheduleFinish(ctx, leader);
    }
  }
  const row = await finishRow(ctx, { projectId, submissionId: state.id });
  if (
    row &&
    !JSON.parse(row.value).pending &&
    state.observation.pendingReason !== 'waiting-for-dependency' &&
    state.observation.pendingReason !== 'waiting-for-review' &&
    ['ready', 'terminal-failed', 'landed'].includes(state.phase)
  )
    await scheduleFinish(ctx, row);
  if (state.phase !== 'landed' && state.phase !== 'terminal-failed') return;
  const dependents = await ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_parent_and_waiting', q =>
      q.eq('projectId', projectId).eq('parentSubmissionId', state.id).eq('waiting', true),
    )
    .take(1);
  if (dependents.length)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedFinishDriver:dependents'),
      { projectId, submissionId: state.id },
    );
}
/** New-run wake (incident 5e3c3a3c, rule N1). A passed follower parked behind an entry that was
 * about to land waited out that entry's whole re-check: the entry kept its order, and
 * no event re-ran the follower's claim. The wake fires in the one write where waiting
 * stops being needed AND the overtake can be charged: the entry starts checking a run
 * (entering `checking`, or binding a new run while checking) while it holds order and
 * `overtakeOlder` says `spend` (not urgent, never overtaken). The woken claim then records
 * the lifetime mark atomically, so this entry re-checks at most once for followers. A
 * merely queued entry is `free` to overtake and records nothing (review c6953f0b), so it
 * never wakes anyone; a carry re-pin, bookkeeping or parking write never enters
 * `checking` with a run (G2, Rule 1: waking on those made extra proofs and a cascade). */
export function bindsNewRun(
  row: Doc<'projectHostedLandingRequests'>,
  previous: Pick<HostedLandingState, 'phase'>,
  state: Pick<HostedLandingState, 'phase' | 'attemptId'>,
  runId: string | null,
  orderLive: boolean,
) {
  return Boolean(
    row.orderWaited &&
    orderLive &&
    runId &&
    state.phase === 'checking' &&
    (previous.phase !== 'checking' || runId !== row.runId) &&
    overtakeOlder({
      phase: 'checking',
      priority: row.priority,
      attemptId: state.attemptId,
      runId,
      admitted: Boolean(row.admission?.full && row.admission.status === 'passed' && !row.admission.reuse),
      ...(row.overtaken !== undefined ? { overtaken: row.overtaken } : {}),
    }) === 'spend',
  );
}
/** An urgent claim never waits for a non-urgent older entry (`olderLandingAhead`). */
const skipsHolder = (
  waiter: Pick<Doc<'projectHostedLandingRequests'>, 'priority'>,
  holder: Pick<Doc<'projectHostedLandingRequests'>, 'priority'>,
) => waiter.priority === 'urgent' && holder.priority !== 'urgent';
/** The waiter touches a global-risk file itself (`ownGlobalRisk`: every older live entry holds it,
 * whatever the holder), or its latest claim found its footprints overlap the entry it then waited
 * for: on `holder` itself, or on a former holder that landed and left it unhanded (main moved under
 * its files, so its pass is stale). Its paths hold it, not order: only its holder's exit wake releases it, and neither
 * the new-run wake nor a baton drives it (8 concurrent finishes on hot files: +15 scheduled steps and
 * +35 calls without this rule, 43b51a5e landing check). Exact holder only (review 14cf6d7e F1): a
 * waiter handed to `holder` by a former holder that withdrew, failed or parked keeps a valid pass and
 * stays eligible. A full receipt list (HOSTED_ORDER_WAITS) may hide a later wait: unknown, never held.
 * A waiter is never held this way by a holder its claim goes ahead of: one holding a live landing
 * reservation goes ahead of the older entries it holds back, which may be parked on it (case 3
 * shape, review 012bd638); an urgent one skips every non-urgent older entry (`olderLandingAhead`),
 * whatever its paths or its last wait, so it is neither held by its own risk there nor by an overlap
 * on a former urgent holder that landed or on a holder it waited for before it was made urgent
 * (review 48555882 F1). Behind an urgent holder its paths hold it as for any waiter. */
const heldByPaths = (
  waiter: Doc<'projectHostedLandingRequests'>,
  holder: Pick<Doc<'projectHostedLandingRequests'>, 'submissionId' | 'priority'>,
) => {
  if (waiter.reservedUntil !== undefined && waiter.reservedUntil > Date.now()) return false;
  if (skipsHolder(waiter, holder)) return false;
  const waits = waiter.orderWaits ?? [];
  const last = waits[waits.length - 1];
  return (
    waiter.ownGlobalRisk === true ||
    (waits.length < HOSTED_ORDER_WAITS &&
      last?.footprints === 'overlap' &&
      (last.submissionId === holder.submissionId || waiter.orderWaitHanded !== holder.submissionId))
  );
};
/** A waiter handed to `next`, which takes main before it, is marked as handed to it
 * (`orderWaitHanded`), so the new-run wake finds it if `next` re-checks instead. Incident 43b51a5e
 * case 2: handed waiters kept a wait naming a former holder, the new-run wake never found them, and
 * disjoint passed landings waited out each head's whole re-check. The receipt list (`orderWaits`)
 * keeps only waits a claim decided; the waiter's next claim clears the mark. Whatever `next`'s
 * phase: a queued `next` (a conflict cohort or an early resolution) that then binds a run must
 * find it too (finding 4 of 120fcc09). No mark only when the holder `from` landed on the
 * waiter's files (`heldByPaths`): its pass cannot carry anyway. An urgent waiter that `from` did
 * not outrank is marked even then: `from` held it by nothing (`skipsHolder`), and its own claim
 * re-checks a stale pass. */
const handedTo = (
  waiter: Doc<'projectHostedLandingRequests'>,
  next: Doc<'projectHostedLandingRequests'>,
  from: Doc<'projectHostedLandingRequests'>,
  landed: boolean,
) => ({
  orderWait: next.submissionId,
  orderWaitHanded:
    waiter.phase === 'ready' && !(landed && heldByPaths(waiter, from)) ? next.submissionId : undefined,
});
/** A Ready follower whose latest recorded wait is on `holder` itself, held only because the
 * holder was about to land, on footprints not known to overlap. A full receipt list stops
 * recording (HOSTED_ORDER_WAITS), so its latest entry may name a former holder: skip it. */
const passedFollower = (
  waiter: Doc<'projectHostedLandingRequests'>,
  holder: Pick<Doc<'projectHostedLandingRequests'>, 'submissionId' | 'priority'>,
) => {
  // An urgent waiter on a non-urgent holder waits on nothing that holder does: its claim skips it,
  // so it is driven as soon as the holder re-checks (review 48555882 F1: handed on unmarked by a
  // landed urgent holder, or made urgent while parked, it waited out the holder's whole check).
  if (waiter.phase === 'ready' && skipsHolder(waiter, holder)) return true;
  // Handed to this holder by a wake and not claimed since: it waits only because the holder takes
  // main first, so its own claim decides (43b51a5e case 2; c6953f0b's evidence rule is unchanged).
  if (waiter.phase === 'ready' && waiter.orderWaitHanded === holder.submissionId)
    return !heldByPaths(waiter, holder);
  const waits = waiter.orderWaits ?? [];
  const last = waits[waits.length - 1];
  return (
    waiter.phase === 'ready' &&
    waits.length < HOSTED_ORDER_WAITS &&
    last?.submissionId === holder.submissionId &&
    (last.held === 'accepting' || last.held === 'unsealed') &&
    last.footprints !== 'overlap'
  );
};
/** Drive one parked Ready waiter: its own claim decides. Its stall alarm is armed in the same
 * transaction (c329d191: this one drive is its only wake). False when its finish has IO in flight
 * (`pending`): that finish claims again by itself. */
export async function driveParkedWaiter(ctx: MutationCtx, waiter: Doc<'projectHostedLandingRequests'>) {
  const finish = await finishRow(ctx, { projectId: waiter.projectId, submissionId: waiter.submissionId });
  if (!finish || JSON.parse(finish.value).pending) return false;
  const alarm = waiter.alarm
    ? undefined
    : await armLandingAlarm(
        ctx,
        waiter,
        hostedLandingProgressAt(hostedLandingStateSchema.parse(JSON.parse(waiter.value))),
      );
  await ctx.db.patch(waiter._id, {
    orderWait: undefined,
    orderWaitHanded: undefined,
    ...(alarm ? { alarm } : {}),
  });
  // Review d4f55e9f F3: a parked finish has no IO in flight, so its wake is a mutation.
  await scheduleFinish(ctx, finish, 0, true, true);
  return true;
}
/** N1 pass (see `bindsNewRun`): one finish drive per bound run. The oldest eligible follower
 * on the first index page gets the drive and its stall alarm (c329d191); eligible younger
 * ones are handed to it only while it holds order (it takes main before them and wakes them
 * when it lands or leaves the order). Everything else stays parked on the holder, whose
 * own exit wake still releases it. Bounded: one page of 32 rows per chargeable generation. */
export async function wakeNewRunFollower(ctx: MutationCtx, row: Doc<'projectHostedLandingRequests'>) {
  const waiters = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_orderWait_and_sequence', q =>
      q.eq('projectId', row.projectId).eq('orderWait', row.submissionId),
    )
    .order('asc')
    .take(32);
  let woken: Doc<'projectHostedLandingRequests'> | null = null;
  for (const waiter of waiters) {
    if (!passedFollower(waiter, row)) continue;
    if (woken) {
      await ctx.db.patch(waiter._id, handedTo(waiter, woken, row, false));
      if (!woken.orderWaited) await ctx.db.patch(woken._id, { orderWaited: (woken.orderWaited = true) });
      continue;
    }
    if (!(await driveParkedWaiter(ctx, waiter))) continue;
    if (!waiter.orderLive) return;
    woken = waiter;
  }
}
/** An older submission stopped holding its place in the landing order: re-drive
 * the oldest passed entry that waited for it and hand the rest to that entry,
 * which takes main before them anyway. Exact indexed waiters, one drive per
 * transition, never one per waiter; the woken claim re-reads the order. Waiters
 * own no alarm, so every one is reached: each page leaves the index range. */
export async function wakeLandingOrderWaiters(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  speculativeOnly = false,
  readyOnly = false,
  landed = false,
) {
  let next: Doc<'projectHostedLandingRequests'> | null = null;
  // A baton wakes only younger waiters: an older one waits here only for a live reservation
  // (`reservationAhead`), and waking it back could cycle (A -> reserved R -> B -> A) at 0 ms until
  // the reservation ends. The reservation holder's own exit still wakes it.
  let after = readyOnly ? row.sequence : -1;
  for (;;) {
    const waiters = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_orderWait_and_sequence', q =>
        q.eq('projectId', row.projectId).eq('orderWait', row.submissionId).gt('sequence', after),
      )
      .order('asc')
      .take(32);
    for (const waiter of waiters) {
      after = waiter.sequence;
      if (readyOnly && (waiter.phase !== 'ready' || heldByPaths(waiter, row))) continue;
      // A re-pin retires speculative source generations, but this predecessor
      // still owns its ordinary place in acceptance order. Only parked conflict
      // cohorts and exact early resolutions need another compose before settlement.
      const early = Boolean(
        waiter.phase === 'queued' &&
        waiter.batchSelection &&
        hostedLandingAttemptSchema.parse(JSON.parse(waiter.batchSelection)).earlyResolutions?.length &&
        !hostedLandingStateSchema.parse(JSON.parse(waiter.value)).batchId,
      );
      if (
        speculativeOnly &&
        !early &&
        (!waiter.wouldConflict ||
          JSON.parse(waiter.wouldConflict).predecessor?.submissionId !== row.submissionId)
      )
        continue;
      if (next) {
        await ctx.db.patch(waiter._id, handedTo(waiter, next, row, landed));
        if (!next.orderWaited) await ctx.db.patch(next._id, { orderWaited: (next.orderWaited = true) });
        continue;
      }
      const finish = await finishRow(ctx, { projectId: row.projectId, submissionId: waiter.submissionId });
      const drive = finish && !JSON.parse(finish.value).pending;
      // Incident c329d191 (2026-11-05): this one scheduled drive is the waiter's
      // only wake and it can fail (OCC exhaustion). Arm the waiter's stall alarm
      // in this same transaction; landing or a later park cancels it. A queued
      // waiter (a speculative-conflict member, whose alarm went to the predecessor)
      // needs it as much as a ready one (687d1eda review e7137e30 4a).
      const alarm =
        drive && !waiter.alarm
          ? await armLandingAlarm(
              ctx,
              waiter,
              hostedLandingProgressAt(hostedLandingStateSchema.parse(JSON.parse(waiter.value))),
            )
          : undefined;
      await ctx.db.patch(waiter._id, {
        orderWait: undefined,
        orderWaitHanded: undefined,
        ...(early ? { runnable: true } : {}),
        ...(alarm ? { alarm } : {}),
      });
      if (early) await wakeLandingQueue(ctx, { projectId: row.projectId, channel: 'main' });
      // The order ended early: replace its reservation/hold expiry timer.
      // Coalescing with that pending future task strands an already passed
      // cohort until the obsolete bound (stucktrain). A parked finish has no
      // IO in flight; keep its wake identity and cancel the old task atomically.
      // That wake is the settle mutation (review d4f55e9f F3).
      if (drive) await scheduleFinish(ctx, finish, 0, true, true);
      // A waiter that no longer holds its place cannot wake others; wake the next one too.
      // Nor can one nothing drives (a manual request with no finish controller): the
      // followers handed to it would wait on a row nothing writes again (review e7137e30 4a).
      if (waiter.orderLive && (drive || early)) next = waiter;
    }
    // A baton reads one page: waiters past it stay here and this entry's own exit releases them.
    if (readyOnly || waiters.length < 32) return;
  }
}
/** Baton (incident 43b51a5e case 2): Ready followers parked on `row` wait because it takes main
 * before them. When `row` itself parks for a hold that lasts a check (its holder is not about to
 * land), they would wait out that check whatever their paths. Drive the oldest younger one (its own
 * claim decides, with its stall alarm armed) and hand the other Ready followers to it, as an exit
 * wake does. Bounded: one index page (32 rows, one patch each) per long park, strictly increasing in
 * sequence, so baton chains end; waiters that are not Ready or are held by their paths
 * (`heldByPaths`), older ones and those past the page stay with `row`. It runs before the claim's early stale-proof refusal (`refuseStaleLaneProofNow`): when
 * that refusal then recomposes `row`, its followers are already handed on, so its exit wake finds
 * none, and the cohort cap still bounds only that refusal chain. */
export const passParkedFollowers = (ctx: MutationCtx, row: Doc<'projectHostedLandingRequests'>) =>
  wakeLandingOrderWaiters(ctx, row, false, true);
export async function notifyFinishCompose(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const row = await ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', operationId),
    )
    .unique();
  // Completion replaces the compose watchdog; no IO is in flight while it waits.
  if (row) await scheduleFinish(ctx, row, 0, true, true);
  const batch = await ctx.db
    .query('projectHostedLandingBatches')
    .withIndex('by_project_and_compose', q =>
      q.eq('projectId', projectId).eq('composeOperationId', operationId),
    )
    .unique();
  // The index pins the current compose generation. Once it split or entered
  // fallback/checking, its old publication no longer owns the leader's wake:
  // that finish may now be uploading a child cohort or a solo selection.
  if (batch && JSON.parse(batch.value).phase === 'composing') {
    const leader = await finishRow(ctx, {
      projectId,
      submissionId: JSON.parse(batch.value).leaderId ?? batch.batchId,
    });
    if (leader) await scheduleFinish(ctx, leader, 0, true, true);
  }
}
