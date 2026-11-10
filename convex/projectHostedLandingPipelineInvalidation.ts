// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity } from './projectHostedLandingBatchState';
import { loadBatch } from './projectHostedLandingBatchState';
import { landingQueue, wakeLandingQueue } from './projectHostedLandingEvents';
import { cancelUnneededHostedCheck } from './projectHostedCheckCancel';
import { withQueueStatusBatch } from './projectHostedQueueStatusWrite';
import { landingObservation } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
// The writer supplies its store operations so invalidation can run inside every
// generation transition without a store -> pipeline -> store import cycle.
type PipelineStore = Pick<
  typeof import('./projectHostedLandingStore'),
  'loadLanding' | 'loadLandingAttempt' | 'insertLandingAttempt' | 'writeLanding'
>;

/** Retire only descendants of this generation. Restore each original selection
 * as a new immutable deferred attempt; late source/check callbacks cannot land
 * the discarded stack. All work is bounded by configured width * cohort size.
 * `keep` is the new generation's predicted head and receipt (a platform retry
 * of the same Candidate, ea86f3fb): direct dependents pinned to exactly that
 * pair stay, with their checks. Publication still compares the pins. */
async function invalidatePipelineOnce(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: { members: { submissionId: string }[] },
  store: PipelineStore,
  retireMembers = false,
  keep?: { head: string; receiptId: string },
  ownerHold = false,
) {
  const { loadLanding, loadLandingAttempt, insertLandingAttempt, writeLanding } = store;
  const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  const train = queue?.train ?? [];
  let last = -1;
  for (let index = 0; index < train.length; index++)
    if (batch.members.some(member => member.submissionId === train[index])) last = index;
  if (last < 0 || (last === train.length - 1 && !retireMembers)) return false;
  const retired = new Set<string>();
  const invalid = new Set(batch.members.map(member => member.submissionId));
  const removed = new Set<string>(retireMembers ? batch.members.map(member => member.submissionId) : []);
  const runs = new Set<string>();
  for (const submissionId of train.slice(last + 1)) {
    const current = await loadLanding(ctx, { projectId: input.projectId, submissionId });
    if (
      current.row.phase === 'landed' ||
      current.row.phase === 'terminal-failed' ||
      !current.state.batchId ||
      retired.has(current.state.batchId)
    )
      continue;
    const descendant = await loadBatch(ctx, { projectId: input.projectId, batchId: current.state.batchId });
    const pinned = descendant.batch.predecessor;
    if (!pinned || !invalid.has(pinned.submissionId)) continue;
    if (
      keep &&
      pinned.head === keep.head &&
      pinned.receiptId === keep.receiptId &&
      batch.members.some(member => member.submissionId === pinned.submissionId)
    )
      continue;
    retired.add(descendant.batch.id);
    for (const member of descendant.batch.members) {
      invalid.add(member.submissionId);
      removed.add(member.submissionId);
    }
    await ctx.db.patch(descendant.row._id, {
      value: canonicalPayload({ ...descendant.batch, phase: 'superseded' }),
    });
    for (const original of descendant.batch.members) {
      const { row, state } = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: original.submissionId,
      });
      if (row.phase === 'landed' || row.phase === 'terminal-failed') continue;
      if (row.runId) runs.add(row.runId);
      const parent = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      // An owner hold is not a failed check. Keep the old exact binding until
      // it settles, then recompose this member's original selection on main.
      // Only a byte-identical tree may carry this proof to that new Candidate.
      if (ownerHold && parent.check) {
        const { batchId: _batch, ...rest } = state;
        void _batch;
        await writeLanding(
          ctx,
          { ...row, pipelineRetiredAttemptId: state.attemptId },
          {
            ...rest,
            batchSolo: true,
            batchNeedsSoloCompose: true,
            version: state.version + 1,
            observation: landingObservation(state.phase === 'ready' ? 'queued' : 'checking'),
            error: null,
          },
          state.phase !== 'ready',
          false,
        );
        continue;
      }
      const attempt = {
        ...original,
        id: crypto.randomUUID(),
        parentAttemptId: parent.id,
        number: parent.number + 1,
        check: null,
        deferredCheck: true as const,
        operations: { check: crypto.randomUUID(), accept: crypto.randomUUID() },
      };
      await insertLandingAttempt(ctx, attempt);
      const { batchId: _batch, ...rest } = state;
      void _batch;
      await writeLanding(
        ctx,
        row,
        {
          ...rest,
          attemptId: attempt.id,
          version: state.version + 1,
          phase: 'queued',
          observation: landingObservation('queued'),
          error: null,
        },
        true,
        false,
      );
    }
  }
  // All bindings move atomically. Release each old shared run once, after its
  // final waiter has left, rather than querying the same live peers per member.
  for (const runId of runs) await cancelUnneededHostedCheck(ctx, { projectId: input.projectId, runId });
  if (!removed.size) return false;
  await ctx.db.patch(queue!._id, { train: train.filter(id => !removed.has(id)) });
  // Removing only the settled root creates no runnable work. Its caller
  // already releases/wakes the queue; do not schedule and cancel a second wake.
  if (retired.size) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  return true;
}

export async function invalidatePipeline(...args: Parameters<typeof invalidatePipelineOnce>) {
  return withQueueStatusBatch(args[0], () => invalidatePipelineOnce(...args));
}
