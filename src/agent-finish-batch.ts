import { landingDiagnosis } from './landing-diagnosis.js';
import { pendingActionsInfra } from './github-actions-infra.js';
// SPDX-License-Identifier: Apache-2.0
import { prepareOptimistic } from './optimistic-landing.js';
import { batchEligible, enqueueLanding } from './landing-batch-store.js';
import { drainLandingBatches } from './landing-batch.js';
import { viewReceipt, acceptanceReceipt } from './agent-receipts.js';
import { runReceiptWithFailure } from './agent-run-failure.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { FinishAttempt } from './agent-finish-journal.js';
import type { WorkService } from './work.js';

/** Translate durable queue outcomes into the existing finish receipt protocol. */
export async function finishQueuedBatch(work: WorkService, command: FinishAction, attempt: FinishAttempt) {
  const store = work.store;
  const queued = store.select('landingEntries', command.operationId);
  const candidate = store.select('views', attempt.view!.viewId as string)!;
  if (!queued && prepareOptimistic(work, command, candidate)) return;
  if (!queued && !(command.accept && batchEligible(work, command, candidate))) return;
  await enqueueLanding(work, command, candidate);
  await drainLandingBatches(work, command.accept!.channel, command.waitMs);
  const entry = store.select('landingEntries', command.operationId)!;
  if (entry.runId) {
    const run = store.select('runs', entry.runId)!;
    attempt.operations.run = run.id;
    attempt.run = runReceiptWithFailure(store, run);
    attempt.view = viewReceipt(store.select('views', run.viewId)!);
  }
  if (entry.acceptanceId)
    attempt.acceptance = acceptanceReceipt(store.select('channelMoves', entry.acceptanceId)!);
  if (entry.conflictViewId) attempt.view = viewReceipt(store.select('views', entry.conflictViewId)!);
  const infraRun = entry.runId ? store.select('runs', entry.runId) : undefined;
  const infra = infraRun && pendingActionsInfra(infraRun) && entry.status !== 'cancelled';
  const pending = !!infra || ['queued', 'checking', 'awaiting-review'].includes(entry.status);
  return {
    phase: entry.status === 'conflict' ? 'compose' : entry.status === 'accepted' ? 'accept' : 'check',
    status: infra
      ? 'pending-infra'
      : entry.status === 'awaiting-review'
        ? entry.status
        : pending
          ? 'waiting to land'
          : entry.status,
    ...(infra ? { code: 'GITHUB_ACTIONS_PENDING_INFRA', message: attempt.run!.diagnostic } : {}),
    terminal: !pending,
    complete: entry.status === 'accepted',
    batchId: entry.batchId,
    ...landingDiagnosis(store, entry),
    ...(entry.previewDiagnostic
      ? { code: 'INTEGRATION_PREVIEW_EXCLUDED', preview: entry.previewDiagnostic }
      : {}),
    ...(entry.reason
      ? {
          ...(entry.previewDiagnostic
            ? { code: 'INTEGRATION_PREVIEW_EXCLUDED' }
            : entry.status === 'interrupted'
              ? { code: 'EVIDENCE_CHANGED' }
              : {}),
          message: entry.reason,
        }
      : {}),
    ...(attempt.acceptance ? { acceptance: attempt.acceptance } : {}),
  };
}
