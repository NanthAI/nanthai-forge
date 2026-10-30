// SPDX-License-Identifier: Apache-2.0
import { checkWakeRow, scheduleCheckWake } from './projectHostedLandingCheckWake';
export { notifyLandingCheck } from './projectHostedLandingCheckWake';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  ensureLandingQueue,
  landingQueue,
  recordLandingObservation,
  scheduleLandingWake,
  wakeLandingQueue,
  type LandingChannel,
} from './projectHostedLandingEvents';
export { scheduleLandingWake, wakeLandingQueue } from './projectHostedLandingEvents';
import { landingRow } from './projectHostedLandingStore';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { nextLandingRow, nextReadyLandingRow, orderHostedLandingRows } from './projectHostedLandingOrder';
import { canonicalPayload } from '../src/hosted-source-operation';
import { HOSTED_TRAIN_HOLD_MS } from '../src/hosted-landing-batch';

/** The active eligible cohort retains its place while source/check IO runs.
 * Later deferred arrivals wait behind it only while it is live: a member is
 * checking or ready, or its newest compose started under HOSTED_TRAIN_HOLD_MS ago. A dead
 * compose never stops the queue; the train is dropped and its members return
 * through their own finish and check wakes. `held.until` names the one wake a
 * caller schedules when nothing is selectable yet. Eight exact reads at most,
 * plus bounded priority-class heads for non-batchable work. No history scan. */
export async function nextTrainLandingRow(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  now = Date.now(),
  held: { until: number | null } = { until: null },
) {
  // A passed proof accepts before any new check or cohort starts, urgent included.
  const ready = await nextReadyLandingRow(ctx, queue);
  if (ready) return ready;
  if (queue.train?.length) {
    const rows = await Promise.all(
      queue.train.map(submissionId => landingRow(ctx, { projectId: queue.projectId, submissionId })),
    );
    const pending = rows.filter(row => {
      if (!row || row.phase === 'landed' || row.phase === 'terminal-failed' || row.hold) return false;
      const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
      return (
        state.observation.pendingReason !== 'waiting-for-review' &&
        state.observation.pendingReason !== 'waiting-for-dependency'
      );
    });
    if (pending.length) {
      const states = pending.map(row => hostedLandingStateSchema.parse(JSON.parse(row!.value)));
      const first = states[0]!;
      if (!pending.some(row => row!.priority === 'urgent')) {
        const batch = first.batchId
          ? await ctx.db
              .query('projectHostedLandingBatches')
              .withIndex('by_project_and_batch', q =>
                q.eq('projectId', queue.projectId).eq('batchId', first.batchId!),
              )
              .unique()
          : null;
        const unstarted = first.batchId
          ? batch && JSON.parse(batch.value).phase === 'composing'
          : pending.every(row => row!.phase === 'queued' && !row!.runId);
        if (unstarted) {
          const head = await nextLandingRow(ctx, queue);
          if (head?.priority === 'urgent') {
            return head;
          }
        }
      }
      const own = pending.find(row => row!.runnable);
      if (own) return own;
      // A checking or passed (publishing) member has a live owner of record.
      const until = pending.some(row => row!.phase === 'checking' || row!.phase === 'ready')
        ? null
        : Math.max(
            ...states.map(state =>
              Math.max(
                Date.parse(state.timing?.composeStartedAt ?? state.at),
                Date.parse(state.timing?.selectedAt ?? state.at),
              ),
            ),
          ) + HOSTED_TRAIN_HOLD_MS;
      if (until !== null && until <= now) {
        await ctx.db.patch(queue._id, { train: undefined });
        return nextLandingRow(ctx, queue);
      }
      // The train coalesces eligible deferred checks only. Ordinary owner,
      // contributor, dependency and recovery work retains its existing path.
      // Include legacy projections without batchable; at most eight train rows
      // can precede the six priority/batchability heads across all windows.
      const members = new Set(queue.train);
      const outside = [];
      for (const priority of ['urgent', 'normal', undefined] as const) {
        for (const batchable of [false, undefined]) {
          let after = -1;
          for (let skipped = 0; skipped <= members.size; skipped++) {
            const [row] = await ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_channel_runnable_batchable_priority_sequence', q =>
                q
                  .eq('projectId', queue.projectId)
                  .eq('channel', queue.channel)
                  .eq('runnable', true)
                  .eq('batchable', batchable)
                  .eq('priority', priority)
                  .gt('sequence', after),
              )
              .order('asc')
              .take(1);
            if (!row) break;
            if (!members.has(row.submissionId)) {
              outside.push(row);
              break;
            }
            after = row.sequence;
          }
        }
        if (priority === 'urgent' && outside.length) break;
      }
      const next = orderHostedLandingRows(outside)[0] ?? null;
      if (!next) held.until = until;
      return next;
    }
    await ctx.db.patch(queue._id, { train: undefined });
  }
  return nextLandingRow(ctx, queue);
}
export async function retainLandingTrain(ctx: MutationCtx, input: LandingChannel, submissions: string[]) {
  const queue = await ensureLandingQueue(ctx, input);
  await ctx.db.patch(queue._id, { train: submissions });
}
export async function releaseLandingQueue(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  now = Date.now(),
) {
  if (queue.wake) await ctx.scheduler.cancel(queue.wake.taskId);
  await ctx.db.patch(queue._id, { lease: null, wake: null });
  // Publication only needs a presence probe; the next claim applies priority.
  const held = { until: null as number | null };
  const pending = queue.train?.length
    ? await nextTrainLandingRow(ctx, queue, now, held)
    : (
        await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
            q.eq('projectId', queue.projectId).eq('channel', queue.channel).eq('runnable', true),
          )
          .take(1)
      )[0];
  if (pending || held.until !== null) {
    const current = (await landingQueue(ctx, queue))!;
    await scheduleLandingWake(ctx, current, pending ? now : held.until!, now);
  }
}
/** Consume a bounded metadata window. Removing checking from the matching index
 * permits continuation without scanning prior terminal work or skipping rows. */
export async function wakeLandingCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
    wakeId: string;
  },
) {
  const wake = await checkWakeRow(ctx, input);
  if (wake?.wake?.id !== input.wakeId) return;
  const page = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_run_and_phase', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', 'checking'),
    )
    .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 96 * 1024 });
  for (const row of page.page) {
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    state.phase = 'queued';
    state.version++;
    // Keep the checking observation until the original run is evaluated.
    await recordLandingObservation(ctx, state, null);
    await ctx.db.patch(row._id, { phase: 'queued', runnable: true, value: canonicalPayload(state) });
  }
  if (page.page.length) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (!page.isDone) await scheduleCheckWake(ctx, { projectId: input.projectId, runId: input.runId }, wake);
  else await ctx.db.patch(wake._id, { wake: null });
}
