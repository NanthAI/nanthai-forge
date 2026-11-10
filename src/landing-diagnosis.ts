// SPDX-License-Identifier: Apache-2.0
import { passingCheckExit } from './check-backend.js';
import { gateCheck } from './check-reuse-key.js';
import { validateReusedCheck } from './check-reuse-evidence.js';
import { invariant } from './errors.js';
import { batchDiagnosis } from './landing-observation.js';
export { diagnosticCause, diagnosticStatus, batchDiagnosis } from './landing-observation.js';
import type { BatchPrefix, LandingBatch, LandingEntry } from './landing-batch-types.js';
import type { CheckRun } from './work-types.js';
import type { WorkService } from './work.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<
  WorkStore,
  'directory' | 'load' | 'locked' | 'native' | 'readRecords' | 'root' | 'save' | 'select'
>;

/** Recovery may reuse only the original exact composition/definition/runtime. */
export function validatePrefixRun(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  run: CheckRun,
) {
  const first = work.store.select('landingEntries', batch.entryIds[0]!)!;
  const view = work.store.select('views', prefix.viewId)!;
  invariant(
    run.id === prefix.runId &&
      run.viewId === prefix.viewId &&
      run.head === prefix.head &&
      run.base === batch.base &&
      run.check.id === first.checkId &&
      run.check.definition === first.definition &&
      run.environment.fingerprint === (batch.environment?.fingerprint ?? first.environment) &&
      JSON.stringify(run.inputs) === JSON.stringify(view.inputs) &&
      JSON.stringify(run.dependencies) === JSON.stringify(view.dependencies ?? []),
    'EVIDENCE_CHANGED',
    'Retained landing check pins do not match this diagnostic prefix. Original evidence is preserved.',
  );
}

/** Rechecked inside acceptance publication; a diagnostic cursor is never passing evidence. */
export function validatePassingPrefix(work: WorkService, batch: LandingBatch, prefix: BatchPrefix) {
  const run = work.store.select('runs', prefix.runId);
  invariant(run, 'CHECK_REQUIRED', 'The passing prefix needs its original recorded check.');
  validatePrefixRun(work, batch, prefix, run);
  validateReusedCheck(work.store, run);
  invariant(
    run.status === 'passed' &&
      gateCheck(run) &&
      !!run.endedAt &&
      passingCheckExit(run) &&
      !run.signal &&
      !run.cancelRequested &&
      work.store.select('checks', run.check.id)?.definition === run.check.definition,
    'EVIDENCE_CHANGED',
    'The passing prefix no longer has complete applicable check evidence. Its original diagnostic is retained.',
  );
}

/** Source verdicts are conditional on the recorded main; speculative observations stay provisional. */
export function landingDiagnosis(store: StoreAccess, entry: LandingEntry) {
  return batchDiagnosis(entry.batchId ? store.select('landingBatches', entry.batchId) : undefined);
}
export type LandingDiagnosisReport = NonNullable<ReturnType<typeof landingDiagnosis>['diagnosis']>;
