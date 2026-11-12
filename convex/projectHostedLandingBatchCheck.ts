// SPDX-License-Identifier: Apache-2.0
import { withQueueStatusBatch } from './projectHostedQueueStatusWrite';
import { diagnoseBatchFailure } from '../src/hosted-batch-diagnosis';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { isolateFailedBatch } from './projectHostedLandingIsolation';
import { passedAlone } from '../src/hosted-landing-suspect';
import { checkFailureStep } from './projectHostedCheckFailure';
import { checkFailureKind } from '../src/hosted-landing-admission';
import { admittedReuseFirst, loneAdmission } from './projectHostedLandingAdmission';
import { holdForPeers } from './projectHostedLandingCohortHold';
import {
  recordCohortOutcome,
  retryLandingBatchCheck,
  splitLandingBatch,
} from './projectHostedLandingBatchSplit';
import { ForgeError, invariant } from '../src/errors';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { semanticVerdict } from '../src/intent-semantic-conflict';
import type { MutationCtx } from './_generated/server';
import type { LandingClaim, requireLandingLease } from './projectHostedLandingControl';
import {
  formLandingBatch,
  installBatchAttempt,
  loadBatch,
  wakeBatch,
  writeBatch,
} from './projectHostedLandingBatchStore';
import { loadLanding, writeLanding } from './projectHostedLandingStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { enqueueHostedCheck } from './projectHostedChecks';
import { retainLandingTrain, releaseLandingQueue } from './projectHostedLandingWake';
import { hostedCheckTerminal } from '../src/hosted-check';
import { landingObservation } from '../src/hosted-landing';
import { hostedStartMain } from './projectHostedChannels';
import { loadFinish } from './projectHostedFinishStore';
import { reserveFinishRetry } from './projectHostedFinishCompose';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { retainCheckProgress } from './projectHostedLandingCheckProgress';

/** Runs within the ordinary queue tick. There is no second check observer. */
async function prepareLandingCheckOnce(
  ctx: MutationCtx,
  claim: LandingClaim,
  selected: Awaited<ReturnType<typeof requireLandingLease>>,
  now: number,
) {
  const { state, attempt, queue } = selected;
  if (state.batchOriginId && state.batchNeedsSoloCompose) {
    const key = { projectId: claim.projectId, batchId: state.batchOriginId };
    const { batch } = await loadBatch(ctx, key);
    await advanceBatchFallback(ctx, key, batch, state.id);
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  if (state.batchId && !state.batchSolo) {
    const key = { projectId: claim.projectId, batchId: state.batchId };
    const { batch } = await loadBatch(ctx, key);
    if (batch.phase === 'checking' && batch.runId) {
      const { run } = await loadHostedCheck(ctx, {
        projectId: claim.projectId,
        runId: batch.runId,
      });
      retainCheckProgress(state, run, now);
      if (hostedCheckTerminal(run)) {
        const semantic = semanticVerdict(
          run.semanticPlan,
          run.reportSummary?.semantic ?? run.contractReports ?? {},
          {
            candidateId: attempt.candidate.id,
            head: attempt.candidate.head!,
            runId: run.id,
          },
          batch.memberDetails
            ?.filter(member => !batch.included || batch.included.includes(member.submissionId))
            .map(member => member.intentId),
        );
        const details = (batch.memberDetails ?? []).filter(
          member => !batch.included || batch.included.includes(member.submissionId),
        );
        const outcome = checkFailureKind(run, semantic);
        if (outcome === 'platform') {
          // Runner unavailable, Actions 403/server error, cancelled or timed out:
          // no test failed, so the cohort stays together and checks again.
          await retryLandingBatchCheck(ctx, key, batch, attempt, run);
        } else if (outcome === 'passed') {
          await recordCohortOutcome(ctx, key, batch, true);
          await requireHostedCheckEvidence(
            ctx,
            {
              projectId: claim.projectId,
              actor: attempt.actor.id,
              candidateId: attempt.candidate.id,
              head: attempt.candidate.head!,
              authorityEpoch: attempt.authorityEpoch,
              ...attempt.check!,
            },
            run,
          );
          for (const member of batch.members.filter(
            member => !batch.included || batch.included.includes(member.submissionId),
          )) {
            const { row, state: current } = await loadLanding(ctx, {
              projectId: claim.projectId,
              submissionId: member.submissionId,
            });
            if (current.phase === 'terminal-failed' || current.phase === 'landed') continue;
            await writeLanding(
              ctx,
              row,
              {
                ...current,
                ...(current.id === state.id
                  ? { checkProgress: state.checkProgress, timing: state.timing }
                  : {}),
                phase: 'ready',
                version: current.version + 1,
                ...(current.batchDiagnostic ? { batchDiagnostic: passedAlone(current.batchDiagnostic) } : {}),
                ...(run.testFiles ? { testFiles: run.testFiles } : {}),
                observation: landingObservation('queued'),
                error: null,
              },
              false,
            );
          }
        } else {
          await recordCohortOutcome(ctx, key, batch, false);
          // At most eight exact metadata reads in this mutation, only after a
          // failed shared check. Large source path lists never enter batch state.
          const originals = await Promise.all(
            details.map(async member => {
              const original = batch.members.find(entry => entry.submissionId === member.submissionId);
              invariant(original, 'EVIDENCE_CHANGED', 'The original batch member is unavailable.');
              const row = await readHostedRecord(ctx, {
                projectId: claim.projectId,
                actor: original.actor.id,
                kind: 'candidate',
                key: original.candidate.id,
              });
              invariant(
                row?.digest === original.candidate.digest,
                'EVIDENCE_CHANGED',
                'The original batch member Candidate changed.',
              );
              const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
              return {
                ...member,
                paths: candidate.governance?.paths ?? member.paths,
              };
            }),
          );
          // Repeat-offender evidence: each member's previous combined failure.
          const previous: Record<string, string[]> = {};
          for (const member of details) {
            const { state: current } = await loadLanding(ctx, {
              projectId: claim.projectId,
              submissionId: member.submissionId,
            });
            const prior = current.batchDiagnostic;
            if (prior?.sharedRunId && prior.sharedRunId !== run.id)
              previous[member.submissionId] = prior.failedTests;
          }
          // No failing test file: name the failing step from the sealed job
          // summaries (bounded, failure-only, no fetch). Wave 1: build:web budget.
          const step = await checkFailureStep(ctx, claim.projectId, run);
          const failure = diagnoseBatchFailure(originals, run, semantic, previous, step);
          if (
            !(await isolateFailedBatch(
              ctx,
              key,
              batch,
              failure,
              attempt,
              run,
              semantic.conflicts.length > 0 || Boolean(semantic.overBudget),
            ))
          )
            await splitLandingBatch(ctx, key, batch, failure);
        }
      } else {
        // Progress may have made this request temporarily queued. Evaluation
        // restores the train projection atomically; its run owns completion in
        // either phase, independently of this queue tick.
        await writeLanding(
          ctx,
          selected.row,
          {
            ...state,
            phase: 'checking',
            version: state.version + 1,
            observation: run.failureReason?.startsWith('provider-delayed:')
              ? { state: 'pending', pendingReason: 'pending-infra', cause: null }
              : landingObservation('checking'),
          },
          false,
        );
      }
    }
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  if (!attempt.deferredCheck) return false;
  if (!state.batchSolo && (await admittedReuseFirst(ctx, selected))) {
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  // A refused admitted member waits for peers still deciding their own Lane proof,
  // so they form one cohort (10b0a94b). Bounded, holds no order, armed wake.
  if (await holdForPeers(ctx, selected)) {
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  if (!state.batchSolo && (await formLandingBatch(ctx, claim, { row: selected.row, state }))) {
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  if (!state.batchSolo && (await loneAdmission(ctx, claim, selected))) {
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  await retainLandingTrain(ctx, claim, [state.id]);
  const main = await hostedStartMain(ctx, claim.projectId);
  if (main.head !== attempt.main.head || main.receipt.id !== attempt.main.receiptId) {
    const finish = await loadFinish(ctx, claim);
    if (!finish.value.pending) await reserveFinishRetry(ctx, finish.row, finish.value);
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  const selection = state.request.check;
  if (selection?.kind !== 'request' || !attempt.candidate.head) return false;
  const { kind: _kind, ...settings } = selection;
  void _kind;
  const run = await enqueueHostedCheck(ctx, {
    projectId: claim.projectId,
    actor: attempt.actor.id,
    ...(attempt.recheck ? { recheck: attempt.recheck } : {}),
    request: {
      ...settings,
      operationId: attempt.operations.check,
      authorityEpoch: attempt.authorityEpoch,
      candidateId: attempt.candidate.id,
      expectedHead: attempt.candidate.head,
    },
  });
  await installBatchAttempt(ctx, {
    projectId: claim.projectId,
    original: attempt,
    check: {
      runId: run.id,
      checkId: run.check.id,
      definition: run.check.definition,
      configuration: run.request.expectedConfiguration,
      environment: run.request.expectedEnvironment,
    },
  });
  await releaseLandingQueue(ctx, queue, now);
  return true;
}

/** A structured batch-evidence failure returns members to exact individual
 * attempts. Unexpected storage/scheduler errors still abort the transaction. */
export async function prepareLandingCheck(...args: Parameters<typeof prepareLandingCheckOnce>) {
  try {
    return await withQueueStatusBatch(args[0], () => prepareLandingCheckOnce(...args));
  } catch (error) {
    const [ctx, claim, selected, now] = args;
    if (!(error instanceof ForgeError) || !selected.state.batchId || selected.state.batchSolo) throw error;
    const key = { projectId: claim.projectId, batchId: selected.state.batchId };
    const { batch } = await loadBatch(ctx, key);
    await writeBatch(ctx, key, {
      ...batch,
      phase: 'fallback',
      transition: { code: error.code, message: error.message },
    });
    await releaseLandingQueue(ctx, selected.queue, now);
    await wakeBatch(ctx, key);
    return true;
  }
}
