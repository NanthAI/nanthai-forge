import { ForgeError } from '../src/errors';
import { semanticVerdict } from '../src/intent-semantic-conflict';
// SPDX-License-Identifier: Apache-2.0
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
import { releaseLandingQueue } from './projectHostedLandingWake';
import { hostedCheckTerminal } from '../src/hosted-check';
import { landingObservation } from '../src/hosted-landing';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';

/** Runs within the ordinary queue tick. There is no second check observer. */
async function prepareLandingCheckOnce(
  ctx: MutationCtx,
  claim: LandingClaim,
  selected: Awaited<ReturnType<typeof requireLandingLease>>,
  now: number,
) {
  const { state, attempt, queue } = selected;
  if (state.batchId && !state.batchSolo) {
    const key = { projectId: claim.projectId, batchId: state.batchId };
    const { batch } = await loadBatch(ctx, key);
    if (batch.phase === 'checking' && batch.runId) {
      const { run } = await loadHostedCheck(ctx, { projectId: claim.projectId, runId: batch.runId });
      if (hostedCheckTerminal(run)) {
        const semantic = semanticVerdict(run.semanticPlan, run.contractReports ?? {}, {
          candidateId: attempt.candidate.id,
          head: attempt.candidate.head!,
          runId: run.id,
        });
        if (run.status === 'passed' && !semantic.overBudget && !semantic.conflicts.length) {
          await requireHostedCheckEvidence(ctx, {
            projectId: claim.projectId,
            actor: attempt.actor.id,
            candidateId: attempt.candidate.id,
            head: attempt.candidate.head!,
            authorityEpoch: attempt.authorityEpoch,
            ...attempt.check!,
          });
          for (const member of batch.members) {
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
                phase: 'ready',
                version: current.version + 1,
                ...(run.testFiles ? { testFiles: run.testFiles } : {}),
                observation: landingObservation('queued'),
                error: null,
              },
              false,
            );
          }
        } else {
          await writeBatch(ctx, key, { ...batch, phase: 'fallback' });
          await wakeBatch(ctx, key);
        }
      }
    }
    await releaseLandingQueue(ctx, queue, now);
    return true;
  }
  if (!attempt.deferredCheck) return false;
  if (!state.batchSolo && (await formLandingBatch(ctx, claim, { row: selected.row, state }))) {
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
    return await prepareLandingCheckOnce(...args);
  } catch (error) {
    const [ctx, claim, selected, now] = args;
    if (!(error instanceof ForgeError) || !selected.state.batchId || selected.state.batchSolo) throw error;
    const key = { projectId: claim.projectId, batchId: selected.state.batchId };
    const { batch } = await loadBatch(ctx, key);
    await writeBatch(ctx, key, { ...batch, phase: 'fallback' });
    await releaseLandingQueue(ctx, selected.queue, now);
    await wakeBatch(ctx, key);
    return true;
  }
}
