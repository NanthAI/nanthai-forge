// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { batchMemberDiagnostic } from '../src/hosted-batch-diagnosis';
import { canonicalPayload } from '../src/hosted-source-operation';
import { loadLanding, writeLanding } from './projectHostedLandingStore';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { writeBatch, type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchStore';

/** One bounded window, no function calls per member and no diagnostic checks.
 * Diagnoses survive terminal outcomes so either member can read a named pair. */
export async function advanceBatchFallback(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  submissionId = batch.id,
) {
  const suspects = new Set(batch.failure?.suspects ?? []);
  const ordered = [...batch.members].sort(
    (a, b) => Number(suspects.has(a.submissionId)) - Number(suspects.has(b.submissionId)),
  );
  const current = await Promise.all(
    ordered.map(member =>
      loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId }),
    ),
  );
  const pending = current.filter(member => !['landed', 'terminal-failed'].includes(member.state.phase));
  // Preserve an already-running original attempt, including replay after a lost wake.
  const next =
    pending.find(member => member.state.batchSolo && !member.state.batchNeedsSoloCompose) ?? pending[0];
  for (const member of current) {
    const diagnostic = batchMemberDiagnostic(
      batch.memberDetails ?? [],
      batch.failure,
      member.state,
      next?.state.id ?? null,
    );
    if (canonicalPayload(member.state.batchDiagnostic ?? null) === canonicalPayload(diagnostic)) continue;
    member.state = await writeLanding(
      ctx,
      member.row,
      { ...member.state, batchDiagnostic: diagnostic, version: member.state.version + 1 },
      member.row.runnable,
    );
  }
  if (!next) {
    if (batch.phase !== 'landed') await writeBatch(ctx, input, { ...batch, phase: 'landed' });
    return { handled: true, command: null };
  }
  for (const member of pending) {
    if (member.state.batchNeedsSoloCompose && member.row.runnable)
      await ctx.db.patch(member.row._id, { runnable: false });
  }
  if (!next.state.batchNeedsSoloCompose) return { handled: next.state.id !== submissionId, command: null };
  const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: next.state.id });
  if (finish.value.pending) {
    // Keep the guard until the new individual attempt is installed. A queue
    // claim racing source preparation must never evaluate the old shared run.
    await ctx.db.patch(next.row._id, { runnable: false });
    return { handled: next.state.id !== submissionId, command: null };
  }
  await reserveFinishRetry(ctx, finish.row, finish.value);
  return { handled: true, command: null };
}
