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
  const pending = ['queued', 'checking'].includes(entry.status);
  return {
    phase: entry.status === 'conflict' ? 'compose' : entry.status === 'accepted' ? 'accept' : 'check',
    status: pending ? 'waiting to land' : entry.status,
    terminal: !pending,
    complete: entry.status === 'accepted',
    batchId: entry.batchId,
    ...(entry.previewDiagnostic
      ? { code: 'INTEGRATION_PREVIEW_EXCLUDED', preview: entry.previewDiagnostic }
      : {}),
    ...(entry.reason
      ? {
          code: entry.previewDiagnostic ? 'INTEGRATION_PREVIEW_EXCLUDED' : 'EVIDENCE_CHANGED',
          message: entry.reason,
        }
      : {}),
    ...(attempt.acceptance ? { acceptance: attempt.acceptance } : {}),
  };
}
