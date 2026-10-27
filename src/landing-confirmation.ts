// SPDX-License-Identifier: Apache-2.0
import { runDetails } from './work-detail-store.js';
import { finishChild } from './finish-child.js';
import { batchEdit } from './landing-batch-store.js';
import { diagnosticStatus, recordDiagnosisNode } from './landing-diagnosis.js';
import type { LandingBatch } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';
import type { WorkService } from './work.js';

/** All proper remote prefixes passed: observe the failed boundary once more,
 * using the whole exact Candidate so a pass can satisfy the existing gate.
 * Reserve its new operation before dispatch; restart adopts it, never loops. */
export async function reserveBoundaryConfirmation(
  work: WorkService,
  batch: LandingBatch,
  failingViewId: string | undefined,
  driver: LandingDriver,
) {
  if (batch.mode !== 'parallel' || batch.confirmation || batch.prefixes.length < 2) return false;
  const full = batch.prefixes.at(-1)!;
  if (
    failingViewId !== full.viewId ||
    full.entryIds.some(id => {
      const entry = work.store.select('landingEntries', id);
      return (
        entry?.status === 'cancelled' ||
        entry?.semanticConflicts?.length ||
        entry?.error?.code === 'CONTRACT_OVER_BUDGET'
      );
    })
  )
    return false;
  const failed = work.store.select('runs', full.runId);
  if (
    !failed ||
    diagnosticStatus(failed) !== 'failed' ||
    !failed.backend ||
    failed.backend.actual === 'local'
  )
    return false;
  if (
    !batch.prefixes.slice(0, -1).every(prefix => {
      const run = work.store.select('runs', prefix.runId);
      return run && diagnosticStatus(run) === 'passed';
    })
  )
    return false;
  // Standard runners retain the executed selection. A whole-Candidate rerun
  // repeats that selection (including the failed files), with a fresh operation.
  const detailed = runDetails(work.store, failed);
  const failedTests = detailed
    .backend!.testVerdicts?.filter(test => test.verdict === 'failed')
    .map(test => test.test);
  const confirmation = {
    failedRunId: failed.id,
    runId: finishChild(batch.id, `confirm:${failed.id}`),
    tests: failedTests?.length ? failedTests : (detailed.checkSelection?.tests ?? []),
  };
  return batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      const prefix = saved.prefixes.at(-1)!;
      if (saved.status !== 'checking' || saved.confirmation || prefix.runId !== failed.id) return false;
      for (const observed of saved.prefixes) {
        const run = data.runs.find(run => run.id === observed.runId);
        if (run)
          recordDiagnosisNode(
            data,
            saved,
            observed,
            observed === prefix ? undefined : prefix,
            run,
            work.store,
          );
      }
      saved.confirmation = confirmation;
      prefix.runId = confirmation.runId;
      delete saved.settlement;
      for (const entry of data.landingEntries ?? [])
        if (entry.batchId === batch.id && entry.status === 'checking')
          entry.waitingFor = {
            rule: 'failure-confirmation',
            reason: 'Waiting for one fresh check of the failed boundary Candidate before attribution.',
            entries: [],
            batchId: batch.id,
            runIds: [confirmation.runId],
          };
      return true;
    },
    driver.beforePublish,
    batch.channel,
  );
}
