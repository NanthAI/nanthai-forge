// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchState';
import type { BatchDropped } from '../src/hosted-landing-batch';
import { predecessorLane } from './projectHostedEarlyResolution';
import { earlyResolutionChoice, earlyResolutionSamplesSchema } from '../src/early-resolution';
import { landingQueue, loadLandingAttempt } from './projectHostedLandingStore';
import { loadBatch } from './projectHostedLandingBatchState';
import { landingRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { wouldConflictSchema } from '../src/hosted-would-conflict';
import { invariant } from '../src/errors';

/** A speculative rejection is advice, never terminal evidence. Park only the
 * rejected members of this bounded cohort on the predecessor's existing order-settlement event. No run,
 * replacement attempt, periodic wake or per-member Convex call is allocated. */
export async function deferSpeculativeConflict(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  dropped: BatchDropped,
  // For an internal prefix, use the included tail's existing settlement event.
  waitFor = batch.predecessor,
) {
  invariant(waitFor, 'WORK_STALE', 'Retain the unaccepted prefix owner.');
  const members = batch.members.filter(member =>
    dropped.some(drop => drop.candidateId === member.candidate.id),
  );
  const loaded = await Promise.all(
    members.map(member =>
      loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId }),
    ),
  );
  // Replaying the same signed source result retains its existing event owner and advice.
  // Do not walk the train, reread history or rewrite observations on an idempotent replay.
  if (
    loaded.length &&
    loaded.every(({ row, state }) => {
      const advice = row.wouldConflict ? JSON.parse(row.wouldConflict) : null;
      return (
        state.batchId === batch.id &&
        state.phase === 'queued' &&
        !row.alarm &&
        advice?.resolution &&
        advice.at === batch.at &&
        row.orderWait === advice.predecessor?.submissionId
      );
    })
  )
    return;
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  // Select the last retained chain member that actually contains the conflicting prefix.
  // No path or graph heuristic establishes ancestry here: follow exact pipeline pins.
  // Members of the composing cohort have not installed its predicted head yet.
  const composing = new Set(batch.members.map(member => member.submissionId));
  const tailId = [...(queue?.train ?? [])].reverse().find(id => !composing.has(id));
  if (tailId && tailId !== waitFor.submissionId) {
    const tail = await loadLanding(ctx, { projectId: input.projectId, submissionId: tailId });
    const attempt = await loadLandingAttempt(ctx, {
      projectId: input.projectId,
      attemptId: tail.state.attemptId,
    });
    let current = tail.state;
    for (
      let depth = 0;
      ['checking', 'ready'].includes(tail.state.phase) &&
      current.batchId &&
      depth < (queue?.train?.length ?? 0);
      depth++
    ) {
      const previous = (await loadBatch(ctx, { projectId: input.projectId, batchId: current.batchId })).batch
        .predecessor;
      if (!previous) break;
      if (
        previous.submissionId === waitFor.submissionId &&
        previous.head === waitFor.head &&
        previous.receiptId === waitFor.receiptId
      ) {
        if (['checking', 'ready'].includes(tail.state.phase) && attempt.candidate.head)
          waitFor = {
            submissionId: tailId,
            head: attempt.candidate.head,
            receiptId: attempt.operations.accept,
          };
        break;
      }
      current = (await loadLanding(ctx, { projectId: input.projectId, submissionId: previous.submissionId }))
        .state;
    }
  }
  const decision = earlyResolutionChoice(
    batch.members[0]!.policy.acceptance.earlyResolve,
    queue?.earlyResolveSamples
      ? earlyResolutionSamplesSchema.parse(JSON.parse(queue.earlyResolveSamples))
      : [],
  );
  const rate =
    decision.failureRate === null
      ? 'unknown (no predecessor outcomes yet)'
      : `${(decision.failureRate * 100).toFixed(1)}% over ${decision.samples} predecessor outcomes`;
  const saved =
    decision.waitSavedMs === null
      ? 'unknown (no completed resolution timing yet)'
      : `${(decision.waitSavedMs / 60000).toFixed(2)} minutes`;
  const predecessor = await loadLanding(ctx, {
    projectId: input.projectId,
    submissionId: waitFor.submissionId,
  });
  const laneId = await predecessorLane(ctx, input.projectId, predecessor.state.id, predecessor.state);
  for (const [index, member] of members.entries()) {
    const conflict = dropped.find(drop => drop.candidateId === member.candidate.id);
    const { row, state } = loaded[index]!;
    if (state.phase === 'landed' || state.phase === 'terminal-failed') continue;
    let current = row;
    if (conflict) {
      const paths = conflict.paths ?? [],
        more = conflict.more ?? 0;
      const files = paths.length ? paths.join(', ') : 'the retained conflict files';
      const advice = canonicalPayload(
        wouldConflictSchema.parse({
          code: 'COMPOSITION_CONFLICT',
          resolution: decision,
          predecessor: {
            ...waitFor,
            groupId: predecessor.state.batchId ?? predecessor.state.id,
          },
          paths,
          more,
          at: batch.at,
          next: `Exact COMPOSITION_CONFLICT in ${files}${more ? ` (and ${more} more files)` : ''} against predecessor Lane ${laneId} (submission ${waitFor.submissionId}), saved State ${waitFor.head}, receipt ${waitFor.receiptId}. Project predecessor failure rate: ${rate}; measured wait saved by resolving now: ${saved}. ${decision.early ? `Resolve now (${decision.mode}: ${decision.reason}) against this exact predecessor with sync {\"predecessor\":${JSON.stringify(waitFor)}}.` : `Early resolution is ${decision.mode === 'off' ? 'off' : 'not favored by the measured break-even'}; choose sync {\"predecessor\":${JSON.stringify(waitFor)}} to resolve now, or wait for this predecessor to settle.`}`,
        }),
      );
      if (row.wouldConflict !== advice) {
        await writeLanding(
          ctx,
          { ...row, wouldConflict: advice },
          { ...state, version: state.version + 1 },
          false,
        );
        current = (await landingRow(ctx, { projectId: input.projectId, submissionId: state.id }))!;
      }
    }
    // The predecessor owns rejected-member progress. Relinquish their alarms
    // so a stale compose alarm cannot split independently checking survivors.
    if (current.alarm) await ctx.scheduler.cancel(current.alarm.taskId);
    if (current.alarm || current.orderWait !== predecessor.state.id)
      await ctx.db.patch(current._id, {
        alarm: null,
        orderWait: predecessor.state.id,
      });
  }
  const watch = canonicalPayload(waitFor);
  if (!predecessor.row.orderWaited || predecessor.row.earlyResolveWatch !== watch)
    await ctx.db.patch(predecessor.row._id, { orderWaited: true, earlyResolveWatch: watch });
}
