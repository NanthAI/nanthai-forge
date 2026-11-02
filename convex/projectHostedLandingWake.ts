import { withQueueStatusBatch } from './projectHostedQueueStatusWrite';
// SPDX-License-Identifier: Apache-2.0
import { checkWakeRow, scheduleCheckWake } from './projectHostedLandingCheckWake';
export { notifyLandingCheck } from './projectHostedLandingCheckWake';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  ensureLandingQueue,
  landingQueue,
  scheduleLandingWake,
  wakeLandingQueue,
  type LandingChannel,
} from './projectHostedLandingEvents';
export { scheduleLandingWake, wakeLandingQueue } from './projectHostedLandingEvents';
import { landingRow } from './projectHostedLandingStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedCheckTerminal } from '../src/hosted-check';
import { settleLandingAdmission } from './projectHostedLandingAdmission';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { nextLandingRow, nextReadyLandingRow, orderHostedLandingRows } from './projectHostedLandingOrder';
import { loadBatch } from './projectHostedLandingBatchState';
import { pipelinePredecessor, invalidatePipeline } from './projectHostedLandingPipeline';
import { HOSTED_TRAIN_HOLD_MS } from '../src/hosted-landing-batch';

/** Retain a bounded stack while source/check IO runs. A fixed tail opens the
 * next speculative slot; publication still follows queue order. Dead composes
 * release their hold after HOSTED_TRAIN_HOLD_MS. Read at most width * eight
 * member rows plus indexed priority heads, never queue or acceptance history.
 * `held.until` names the single wake needed when no work is selectable yet. */
export async function nextTrainLandingRow(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  now = Date.now(),
  held: { until: number | null } = { until: null },
): Promise<Doc<'projectHostedLandingRequests'> | null> {
  // A passed proof accepts before any new check or cohort starts, urgent included.
  const ready = await nextReadyLandingRow(ctx, queue);
  if (ready) return ready;
  if (queue.train?.length) {
    const rows = await Promise.all(
      queue.train.map(submissionId => landingRow(ctx, { projectId: queue.projectId, submissionId })),
    );
    // A controller/source error can settle the entire predecessor without a
    // batch-check transition. Retire its descendants on the same queue event.
    const values = rows
      .filter(row => row !== null)
      .map(row => hostedLandingStateSchema.parse(JSON.parse(row.value)));
    const failed = new Set(
      values
        .filter(state => state.phase === 'terminal-failed')
        .map(state => state.batchId)
        .filter(id => id !== undefined),
    );
    for (const batchId of failed) {
      if (values.some(state => state.batchId === batchId && state.phase !== 'terminal-failed')) continue;
      const key = { projectId: queue.projectId, batchId };
      if (await invalidatePipeline(ctx, key, (await loadBatch(ctx, key)).batch))
        return nextTrainLandingRow(ctx, (await landingQueue(ctx, queue))!, now, held);
    }
    const failedSolo = values.filter(state => state.phase === 'terminal-failed' && !state.batchId);
    if (failedSolo.length) {
      for (const state of failedSolo)
        await invalidatePipeline(
          ctx,
          { projectId: queue.projectId, batchId: state.id },
          { members: [{ submissionId: state.id }] },
          true,
        );
      return nextTrainLandingRow(ctx, (await landingQueue(ctx, queue))!, now, held);
    }
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
      // Include legacy projections without batchable; only bounded train rows
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
      // A bounded speculative slot opens once the tail has fixed its source and
      // receipt. All successors compose on that tail, never on competing main.
      if (
        !outside.some(row => row.priority === 'urgent') &&
        (await pipelinePredecessor(ctx, queue, pending as NonNullable<(typeof pending)[number]>[]))
      ) {
        for (const priority of ['urgent', 'normal', undefined] as const) {
          const [row] = await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_channel_runnable_batchable_priority_sequence', q =>
              q
                .eq('projectId', queue.projectId)
                .eq('channel', queue.channel)
                .eq('runnable', true)
                .eq('batchable', true)
                .eq('priority', priority),
            )
            .order('asc')
            .take(1);
          if (row) outside.push(row);
        }
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
  const live = await Promise.all(
    (queue.train ?? []).map(submissionId => landingRow(ctx, { projectId: input.projectId, submissionId })),
  );
  await ctx.db.patch(queue._id, {
    train: [
      ...new Set([
        ...live
          .filter(row => row && row.phase !== 'landed' && row.phase !== 'terminal-failed')
          .map(row => row!.submissionId),
        ...submissions,
      ]),
    ],
  });
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
/** Consume each current run event once per live waiter. Queue phase is only a
 * projection: both queued and checking bindings retain completion ownership.
 * The indexed event version permits bounded continuation without moving phases
 * or revisiting a nonterminal admission. Missing versions include legacy rows. */
async function wakeLandingCheckPage(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    runId: string;
    wakeId: string;
  },
) {
  const wake = await checkWakeRow(ctx, input);
  if (wake?.wake?.id !== input.wakeId) return;
  const version = wake.version ?? 1;
  const rows: Doc<'projectHostedLandingRequests'>[] = [];
  let more = false;
  for (const phase of ['checking', 'queued'] as const) {
    for (const legacy of [true, false]) {
      const page = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_run_phase_checkWakeVersion', q => {
          const bound = q.eq('projectId', input.projectId).eq('runId', input.runId).eq('phase', phase);
          return legacy
            ? bound.eq('checkWakeVersion', undefined)
            : bound.gt('checkWakeVersion', -1).lt('checkWakeVersion', version);
        })
        .paginate({
          cursor: null,
          numItems: 100 - rows.length,
          maximumRowsRead: 100 - rows.length,
          maximumBytesRead: 96 * 1024,
        });
      rows.push(...page.page);
      more ||= !page.isDone;
      if (more || rows.length === 100) break;
    }
    if (more || rows.length === 100) break;
  }
  let run: Awaited<ReturnType<typeof loadHostedCheck>>['run'] | null = null,
    woken = false;
  for (const row of rows) {
    if (row.admission?.status === 'checking' && row.admission.runId === input.runId) {
      await ctx.db.patch(row._id, { checkWakeVersion: version });
      // Progress writes wake too; only the run's own terminal result settles
      // admission, and an unsettled admission costs no queue tick.
      run ??= (await loadHostedCheck(ctx, input)).run;
      if (hostedCheckTerminal(run)) {
        await settleLandingAdmission(ctx, row, run);
        woken = true;
      }
      continue;
    }
    woken = true;
    await ctx.db.patch(row._id, { checkWakeVersion: version, runnable: true });
  }
  if (woken) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  if (more || rows.length === 100)
    await scheduleCheckWake(ctx, { projectId: input.projectId, runId: input.runId }, wake);
  else await ctx.db.patch(wake._id, { wake: null });
}

export const wakeLandingCheck = (ctx: MutationCtx, input: Parameters<typeof wakeLandingCheckPage>[1]) =>
  withQueueStatusBatch(ctx, () => wakeLandingCheckPage(ctx, input));
