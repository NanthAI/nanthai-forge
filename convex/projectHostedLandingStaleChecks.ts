// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import {
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  writeLanding,
} from './projectHostedLandingStore';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { loadBatch, retryLandingBatch } from './projectHostedLandingBatchStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { cancelHostedCheck } from './projectHostedCheckCancel';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedCheckTerminal } from '../src/hosted-check';
import { landingObservation } from '../src/hosted-landing';
import { pathsOverlap } from '../src/hosted-cross-head-proof';
import { firstCheckRiskPaths } from '../src/first-check-risk';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';

/** The existing post-acceptance transaction inspects at most eight running
 * entries. An empty indexed window reads zero documents/bytes. Source and test
 * files are never read here; this waste decision grants no acceptance proof. */
export async function cancelStaleLandingChecks(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    sequence: number;
    receiptIds: string[];
    head: string;
    candidate: { id: string; actor: string; digest: string };
  },
) {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', 'main').eq('phase', 'checking'),
    )
    .take(HOSTED_BATCH_MEMBERS);
  if (!rows.length) return 0;
  const accepted = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.candidate.actor,
    kind: 'candidate',
    key: input.candidate.id,
  });
  if (!accepted || accepted.digest !== input.candidate.digest) return 0;
  const changed = hostedRecordSchema.options[3].parse(JSON.parse(accepted.value)).governance?.paths;
  if (!changed?.length) return 0;
  const main = await hostedStartMain(ctx, input.projectId);
  const project = await ctx.db.get(input.projectId);
  const global =
    firstCheckRiskPaths(changed, [...(project?.checkEntries ?? []), ...(project?.globalRiskPaths ?? [])])
      .length > 0;
  const retired = new Set<string>();
  for (const selected of rows) {
    if (!selected.runId || retired.has(selected.runId)) continue;
    // A previous member may have retired this row's whole cohort/descendants.
    const current = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: selected.submissionId,
    });
    const { row, state } = current;
    if (state.phase !== 'checking' || !row.runId || !state.request.finish) continue;
    const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
    // Exact predicted-head checks already contain this acceptance, including its
    // receipt. An ancestry-only head match cannot conceal a receipt ABA.
    if (
      (attempt.main.head === main.head && attempt.main.receiptId === main.receipt.id) ||
      (attempt.main.head === input.head && input.receiptIds.includes(attempt.main.receiptId))
    )
      continue;
    // A delayed acceptance event cannot retire a run prepared on a later
    // accepted receipt, even when current main has already moved again.
    const base = await acceptanceRow(ctx, { projectId: input.projectId, receiptId: attempt.main.receiptId });
    if (base && base.sequence >= input.sequence) continue;
    const grouped =
      state.batchId && !state.batchSolo
        ? await loadBatch(ctx, { projectId: input.projectId, batchId: state.batchId })
        : null;
    // Pending predicted prefixes already contain the older train acceptances.
    // If that prefix is stale, its own retirement fences all descendants.
    if (
      grouped &&
      (await predecessorStatus(
        ctx,
        { projectId: input.projectId, batchId: grouped.batch.id },
        grouped.batch,
      )) === 'pending'
    )
      continue;
    if (!global) {
      const record = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: state.actor,
        kind: 'candidate',
        key: attempt.candidate.id,
      });
      if (!record || record.digest !== attempt.candidate.digest) continue;
      const paths = hostedRecordSchema.options[3].parse(JSON.parse(record.value)).governance?.paths;
      if (!paths || !pathsOverlap(paths, changed)) continue;
    }
    const runId = row.runId;
    const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId }, false);
    if (hostedCheckTerminal(run)) continue;
    if (state.batchId && !state.batchSolo) {
      const key = { projectId: input.projectId, batchId: state.batchId };
      const { batch } = grouped!;
      if (batch.phase !== 'checking' || batch.runId !== runId) continue;
      // One replacement union, retaining member sequence and the shared check.
      await retryLandingBatch(ctx, key, batch);
    } else {
      const finish = await loadFinish(ctx, { projectId: input.projectId, submissionId: state.id });
      if (finish.value.pending) continue;
      const admission =
        row.admission?.status === 'checking'
          ? {
              ...row.admission,
              status: 'unavailable' as const,
              reuse: 'tried' as const,
              recheck: 'main-moved',
            }
          : row.admission;
      if (admission !== row.admission) await ctx.db.patch(row._id, { admission });
      let attemptId = state.attemptId;
      if (attempt.check) {
        const { crossHeadProof: _proof, check: _check, ...pins } = attempt;
        void [_proof, _check];
        const next = {
          ...pins,
          id: crypto.randomUUID(),
          parentAttemptId: attempt.id,
          number: attempt.number + 1,
          check: null,
          deferredCheck: true as const,
          operations: { check: crypto.randomUUID(), accept: crypto.randomUUID() },
        };
        await insertLandingAttempt(ctx, next);
        attemptId = next.id;
      }
      // A solo fallback member still owns its serial cohort. Keep that identity
      // so its terminal transition wakes the next member after recomposition.
      await writeLanding(
        ctx,
        { ...row, admission },
        {
          ...state,
          attemptId,
          version: state.version + 1,
          phase: 'queued',
          batchSolo: true,
          batchNeedsSoloCompose: true,
          observation: landingObservation('queued'),
          error: null,
        },
        false,
        false,
      );
      // Publication of the replacement's durable wake and cancellation share
      // this transaction. A throw rolls both back; no process owns rescheduling.
      if (finish.row.wake) {
        await ctx.scheduler.cancel(finish.row.wake.taskId);
        await ctx.db.patch(finish.row._id, { wake: null });
      }
      await reserveFinishRetry(ctx, finish.row, finish.value, 'CHECK_EVIDENCE_REFRESH', undefined, main);
    }
    await cancelHostedCheck(ctx, { projectId: input.projectId, runId });
    retired.add(runId);
  }
  return retired.size;
}
