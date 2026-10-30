// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { batchMemberDiagnostic } from '../src/hosted-batch-diagnosis';
import { canonicalPayload } from '../src/hosted-source-operation';
import { loadLanding, loadLandingAttempt, writeLanding } from './projectHostedLandingStore';
import { individualLandingRun } from './projectHostedLandingIndividual';
import { landingObservation } from '../src/hosted-landing';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { writeBatch, type BatchIdentity, type LandingBatch } from './projectHostedLandingBatchStore';
import { orderHostedLandingRows } from './projectHostedLandingOrder';

/** One bounded window, no function calls per member and no diagnostic checks.
 * Diagnoses survive terminal outcomes so either member can read a named pair. */
export async function advanceBatchFallback(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
  submissionId = batch.leaderId ?? batch.id,
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
  for (const member of pending) {
    if (!member.state.batchNeedsSoloCompose || !member.row.runId) continue;
    const original = batch.members.find(entry => entry.submissionId === member.state.id)!;
    const run = await individualLandingRun(
      ctx,
      input.projectId,
      await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: member.state.attemptId }),
      original.candidate,
    );
    if (!run) continue;
    const { batchNeedsSoloCompose: _needs, ...state } = member.state;
    void _needs;
    member.state = await writeLanding(
      ctx,
      member.row,
      {
        ...state,
        batchSolo: true,
        phase: run.status === 'passed' ? 'ready' : 'checking',
        observation: landingObservation(run.status === 'passed' ? 'queued' : 'checking'),
        error: null,
        version: state.version + 1,
      },
      true,
    );
    member.row = (await loadLanding(ctx, { projectId: input.projectId, submissionId: member.state.id })).row;
  }
  // Preserve an already-running original attempt, including replay after a lost wake.
  const running = pending.find(member => member.state.batchSolo && !member.state.batchNeedsSoloCompose);
  let next = running ?? pending[0];
  if (
    !running &&
    pending.some(member => member.row.priority === 'urgent') &&
    pending.some(member => member.row.priority !== 'urgent')
  ) {
    // A previously selected solo source operation continues too. At most eight
    // exact metadata reads, only when an owner mixes fallback priority classes.
    const preparations = await Promise.all(
      pending.map(async member => ({
        member,
        finish: await loadFinish(ctx, { projectId: input.projectId, submissionId: member.state.id }),
      })),
    );
    const inFlight = preparations.find(item => item.finish.value.pending)?.member;
    const queue = orderHostedLandingRows(
      pending.map(member => ({
        sequence: member.row.sequence,
        actor: member.row.actor,
        priority: member.row.priority,
        member,
      })),
    );
    // Keep the existing healthy-first preference within the selected class;
    // a suspect hint cannot override the owner's urgent priority.
    next =
      inFlight ??
      (
        queue.find(entry => entry.priority === queue[0]?.priority && !suspects.has(entry.member.state.id)) ??
        queue[0]
      )?.member;
  }
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
  await reserveFinishRetry(ctx, finish.row, finish.value, 'BATCH_FALLBACK');
  return { handled: true, command: null };
}
