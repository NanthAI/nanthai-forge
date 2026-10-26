// SPDX-License-Identifier: Apache-2.0
import { runDetails } from './work-detail-store.js';
import { gateCheck } from './check-reuse-key.js';
import { validateReusedCheck } from './check-reuse-evidence.js';
import { invariant } from './errors.js';
import { diagnosticCause, batchDiagnosis } from './landing-observation.js';
export { diagnosticCause, diagnosticStatus, batchDiagnosis } from './landing-observation.js';
import { batchEdit } from './landing-batch-store.js';
import type { BatchPrefix, LandingBatch, LandingEntry } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';
import type { CheckRun, WorkData } from './work-types.js';
import type { WorkService } from './work.js';
import type { WorkStore } from './work-store.js';

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
      run.exitCode === 0 &&
      !run.signal &&
      !run.cancelRequested &&
      work.store.select('checks', run.check.id)?.definition === run.check.definition,
    'EVIDENCE_CHANGED',
    'The passing prefix no longer has complete applicable check evidence. Its original diagnostic is retained.',
  );
}

/** Reserve before external work; reconcile observations from canonical runs after a lost reply.
 * The tree contains only probes actually scheduled, and never supplies acceptance authority. */
export async function retainDiagnosisNode(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  parent: BatchPrefix | undefined,
  driver: LandingDriver,
  run?: CheckRun,
) {
  return batchEdit(
    work,
    batch.id,
    data => recordDiagnosisNode(data, batch, prefix, parent, run, work.store),
    driver.beforePublish,
    batch.channel,
  );
}

/** Update diagnosis together with a terminal publication when no search is needed. */
export function recordDiagnosisNode(
  data: WorkData,
  batch: LandingBatch,
  prefix: BatchPrefix,
  parent?: BatchPrefix,
  run?: CheckRun,
  store?: WorkStore,
) {
  if (run?.detailRef) {
    invariant(store, 'INVALID_WORK_STORE', 'Diagnosis needs the retained run detail.');
    run = runDetails(store, run);
  }
  const saved = data.landingBatches!.find(item => item.id === batch.id)!;
  const first = data.landingEntries!.find(entry => entry.id === batch.entryIds[0])!;
  const view = data.views.find(view => view.id === prefix.viewId)!;
  const diagnosis = (saved.diagnosis ??= {
    version: 1,
    strategy: 'prefix',
    minimization: 'incomplete',
    nodes: [],
  });
  let node = diagnosis.nodes.find(node => node.id === prefix.runId);
  if (!node) {
    node = {
      ...prefix,
      id: prefix.runId,
      ...(parent ? { probeAt: new Date().toISOString() } : {}),
      inputs: view.inputs,
      ...(parent ? { parentId: parent.runId } : {}),
      base: batch.base,
      previous: batch.previous,
      checkId: first.checkId,
      definition: first.definition,
      environment: batch.environment?.fingerprint ?? first.environment,
      status: 'reserved',
      selection: { runId: prefix.runId, known: false },
    };
    diagnosis.nodes.push(node);
  }
  if (run) {
    node.status = run.status;
    delete node.cause;
    const cause = diagnosticCause(run);
    if (cause) node.cause = cause;
    node.selection = {
      runId: run.id,
      known: !!run.checkSelection,
      ...(run.checkSelection ? { scope: run.checkSelection.scope, tests: run.checkSelection.tests } : {}),
      ...(run.backend?.pin ? { plan: run.backend.pin } : {}),
    };
  }
}

/** Source verdicts are conditional on the recorded main; speculative observations stay provisional. */
export function landingDiagnosis(store: WorkStore, entry: LandingEntry) {
  return batchDiagnosis(entry.batchId ? store.select('landingBatches', entry.batchId) : undefined);
}
export type LandingDiagnosisReport = NonNullable<ReturnType<typeof landingDiagnosis>['diagnosis']>;
