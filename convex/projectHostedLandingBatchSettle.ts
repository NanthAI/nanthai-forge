// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { recordFailure } from './projectFailureLog';
import {
  batchRow,
  batchSchema,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchState';
import { writeBatch } from './projectHostedLandingBatchStore';
import { invalidatePipeline } from './projectHostedLandingPipeline';

/** Batch phases that still wait on a member's later step. */
const OPEN = new Set<LandingBatch['phase']>(['composing', 'checking', 'fallback']);
type BatchRow = NonNullable<Awaited<ReturnType<typeof batchRow>>>;

/** Item ab5c0017: the open batch when every member is landed or terminal-failed, else null. That is
 * the rule the existing "no live member" exits use (retryLandingBatch, advanceBatchFallback,
 * settleBatchConflicts): any member not yet terminal keeps the batch open, whichever batch pointer
 * it holds. At most HOSTED_BATCH_MEMBERS indexed ticket reads, stopping at the first live member;
 * only the ticket's `phase` column decides. `ended` is a member the caller has just written
 * terminal, so it is not read again. `failed` lists the members that ended terminal-failed. */
async function settledBatch(
  ctx: MutationCtx,
  input: BatchIdentity,
  ended?: { id: string; phase: HostedLandingState['phase'] },
  loaded?: BatchRow,
) {
  const row = loaded ?? (await batchRow(ctx, input));
  if (!row) return null;
  const batch = batchSchema.parse(JSON.parse(row.value));
  if (!OPEN.has(batch.phase)) return null;
  const failed: { submissionId: string }[] = [];
  for (const member of batch.members.slice(0, HOSTED_BATCH_MEMBERS)) {
    let phase: string | undefined = ended?.phase;
    if (member.submissionId !== ended?.id)
      phase = (
        await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_submission', q =>
            q.eq('projectId', input.projectId).eq('submissionId', member.submissionId),
          )
          .unique()
      )?.phase;
    if (phase === 'terminal-failed') failed.push({ submissionId: member.submissionId });
    else if (phase !== 'landed') return null;
  }
  return { row, batch, failed };
}

/** The terminal hook (writeLanding, non-terminal -> landed/terminal-failed). Every way a member
 * ends (cancel, supersede, failFinish from any caller, a stall drop, a solo landing of a member the
 * cohort released) passes here, so a batch can no longer outlive its members: it settles through
 * writeBatch, which releases capsule waits. The shared publish is skipped (a landing that still holds
 * batchId without batchSolo): it writes its batch landed in the same transaction, so a healthy
 * cohort landing pays nothing. Late compose or check IO for a settled batch finds a terminal phase
 * and does nothing. */
export async function settleEndedBatch(ctx: MutationCtx, state: HostedLandingState) {
  const batchId = state.batchId ?? state.batchOriginId;
  if (!batchId || (state.phase === 'landed' && state.batchId && !state.batchSolo)) return;
  const input = { projectId: state.projectId as Id<'hostedProjects'>, batchId };
  const settled = await settledBatch(ctx, input, state);
  if (settled) await settleBatch(ctx, input, settled);
}
/** A composing or checking cohort still pins its pipelined successors: retire those stacked on a
 * member that ended failed, as retryLandingBatch does on its own no-live-member exit (review
 * 000e2d4f). A successor stacked on a member that landed keeps its check (review 2a9d4b2e): its
 * publish still compares the pinned head. A fallback batch already invalidated its pipeline when it
 * entered fallback. */
async function settleBatch(
  ctx: MutationCtx,
  input: BatchIdentity,
  { batch, failed }: { batch: LandingBatch; failed: { submissionId: string }[] },
) {
  if (batch.phase !== 'fallback' && failed.length) await invalidatePipeline(ctx, input, { members: failed });
  await writeBatch(ctx, input, { ...batch, phase: 'landed' });
}

/** Guard (ab5c0017, Done-when 5): the capsule packer's begin step reaches an open batch only when a
 * landing that ended at least the 7-day grace ago still waits on it. After the terminal hook that is
 * a leak: some path ended a member without passing the hook. When no member is live, this settles the
 * batch by the same rule and writes one failure-log row naming it (code LANDING_BATCH_LEAKED, shown by
 * `nforge metrics ROOT --failures`), once per batch. It runs only on that branch, which a healthy
 * batch never reaches (it is terminal long before its members pack), so it adds no calls and no reads
 * there; a batch with a live member costs the ticket reads up to that member and stays deferred.
 * Returns true when it settled the batch, so the caller packs instead of deferring. */
export async function settleLeakedBatch(ctx: MutationCtx, input: BatchIdentity, row: BatchRow) {
  const settled = await settledBatch(ctx, input, undefined, row);
  if (!settled) return false;
  await settleBatch(ctx, input, settled);
  await recordFailure(ctx, {
    projectId: input.projectId,
    operationId: `landing-batch-leak:${input.batchId}`,
    kind: 'landing',
    error: {
      code: 'LANDING_BATCH_LEAKED',
      message: `Landing batch ${input.batchId} stayed ${settled.batch.phase} after all ${settled.batch.members.length} members ended; the capsule pass settled it.`,
    },
    startedAt: settled.batch.drive?.at ?? settled.batch.at,
  });
  return true;
}
