// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { hostedStartMain } from './projectHostedChannels';
import { readHostedRecord } from './projectHostedRecords';
import {
  loadLanding,
  loadLandingAttempt,
  forkLandingAttempt,
  insertLandingAttempt,
  writeLanding,
} from './projectHostedLandingStore';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { loadBatch, retryLandingBatch } from './projectHostedLandingBatchStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { cancelHostedCheck } from './projectHostedCheckCancel';
import { auditFreshness, auditRow, mainGate, VERIFIED_MAIN } from './projectHostedMainAuditState';
import { hostedRecordSchema } from '../src/hosted-records';
import { hostedCheckTerminal } from '../src/hosted-check';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { landingObservation } from '../src/hosted-landing';
import { pathsOverlap } from '../src/hosted-cross-head-proof';
import {
  checkRunEntryPaths,
  firstCheckRiskPaths,
  globalRiskBetween,
  orderSensitiveRisk,
} from '../src/first-check-risk';
import { effectivePolicy } from '../src/autonomy-policy';
import { reducedEvidenceActor } from '../src/contract-gate-policy';
import { fastEffective } from '../src/landing-mode';
import { docsGate, fullGate } from '../src/main-audit';
import { ForgeError } from '../src/errors';
import { placeableRisk } from '../src/package-placement';
import { markdownPath } from '../src/tested-docs';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';

const bestTrust = { level: 'autonomous', reason: 'upper bound' } as const;

async function currentFastMode(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  main: Awaited<ReturnType<typeof hostedStartMain>>,
) {
  const audit = await auditRow(ctx, projectId);
  const gate = await mainGate(ctx, projectId, audit);
  if (gate.status === 'red' || gate.debt) return false;
  if (fastEffective('fast', audit?.window, auditFreshness(audit, gate))) return true;
  // The proof can also use an exact full main receipt, including checks whose
  // runner never created an audit row. Check the live breaker before reading it.
  if (!fastEffective('fast', audit?.window, VERIFIED_MAIN)) return false;
  const row = await acceptanceRow(ctx, { projectId, receiptId: main.receipt.id });
  const receipt = row && hostedAcceptanceSchema.parse(JSON.parse(row.value));
  if (!receipt?.check || receipt.crossHeadProof || receipt.candidate.head !== main.head) return false;
  try {
    const { run } = await loadHostedCheck(ctx, { projectId, runId: receipt.check.runId }, false);
    return run.status === 'passed' && fullGate(run) && !docsGate(run);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    return false;
  }
}

function codeOverlap(paths: string[], changed: string[]) {
  const moved = new Set(changed);
  const sharedDocs = new Set(paths.filter(path => markdownPath(path) && moved.has(path)));
  return (
    pathsOverlap(
      paths.filter(path => !sharedDocs.has(path)),
      changed,
    ) ||
    pathsOverlap(
      paths,
      changed.filter(path => !sharedDocs.has(path)),
    )
  );
}

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
  const policy =
    process.env.FORGE_QUEUE_CANCEL_HONOURS_FAST === '1' && project ? effectivePolicy(project) : null;
  const honourFast =
    project && policy?.acceptance.mode === 'auto-on-pass' && policy.acceptance.hostedCrossHeadReuse !== false;
  let fast: Promise<boolean> | undefined;
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
    // Match the proof's cheap eligibility bound before reading Candidate metadata.
    const mayCarry =
      honourFast &&
      !grouped &&
      !state.request.revertOf &&
      reducedEvidenceActor(policy, project, attempt.actor, policy.trust?.enabled ? bestTrust : null);
    let paths: string[] | undefined;
    if (!global || mayCarry) {
      const record = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: state.actor,
        kind: 'candidate',
        key: attempt.candidate.id,
      });
      if (!record || record.digest !== attempt.candidate.digest) continue;
      paths = hostedRecordSchema.options[3].parse(JSON.parse(record.value)).governance?.paths;
      if (!paths || (!global && !pathsOverlap(paths, changed))) continue;
    }
    const runId = row.runId;
    const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId }, false);
    if (hostedCheckTerminal(run)) continue;
    if (mayCarry && paths && (fullGate(run) || docsGate(run)) && !attempt.semanticPlan?.members.length) {
      const entries = checkRunEntryPaths(run.check);
      // Use the proof's path rules. Selection pins and actual composed bytes
      // still belong to proof construction, so leave possible Markdown merges
      // and placeable package risk to that step.
      if (
        !codeOverlap(paths, changed) &&
        (!globalRiskBetween(paths, changed, entries) ||
          placeableRisk(paths, changed, entries) ||
          (policy.acceptance.landingMode === 'fast' &&
            !orderSensitiveRisk(paths, changed, entries).length &&
            (await (fast ??= currentFastMode(ctx, input.projectId, main)))))
      )
        continue;
    }
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
          ...(await forkLandingAttempt(ctx, state)),
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
        await cancelPendingTask(ctx, finish.row.wake?.taskId);
        await ctx.db.patch(finish.row._id, { wake: null });
      }
      await reserveFinishRetry(ctx, finish.row, finish.value, 'CHECK_EVIDENCE_REFRESH', undefined, main);
    }
    await cancelHostedCheck(ctx, { projectId: input.projectId, runId });
    retired.add(runId);
  }
  return retired.size;
}
