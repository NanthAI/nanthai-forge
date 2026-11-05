// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchState';
import type { BatchDropped } from '../src/hosted-landing-batch';
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
  const predecessor = await loadLanding(ctx, {
    projectId: input.projectId,
    submissionId: waitFor.submissionId,
  });
  for (const member of batch.members.filter(member =>
    dropped.some(drop => drop.candidateId === member.candidate.id),
  )) {
    const conflict = dropped.find(drop => drop.candidateId === member.candidate.id);
    const { row, state } = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: member.submissionId,
    });
    if (state.phase === 'landed' || state.phase === 'terminal-failed') continue;
    let current = row;
    if (conflict) {
      const paths = conflict.paths ?? [],
        more = conflict.more ?? 0;
      const files = paths.length ? paths.join(', ') : 'the retained conflict files';
      const advice = canonicalPayload(
        wouldConflictSchema.parse({
          code: 'COMPOSITION_CONFLICT',
          predecessor: {
            ...waitFor,
            groupId: predecessor.state.batchId ?? predecessor.state.id,
          },
          paths,
          more,
          at: batch.at,
          next: `Advisory COMPOSITION_CONFLICT in ${files}${more ? ` (and ${more} more files)` : ''} against speculative predecessor group ${predecessor.state.batchId ?? predecessor.state.id}. This entry stays queued; Forge will reevaluate its retained merge on accepted main when the predecessor settles. No agent action is needed.`,
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
  if (!predecessor.row.orderWaited) await ctx.db.patch(predecessor.row._id, { orderWaited: true });
}
