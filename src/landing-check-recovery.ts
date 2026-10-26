// SPDX-License-Identifier: Apache-2.0
import { hostname } from 'node:os';
import { finishChild } from './finish-child.js';
import { processAlive } from './local-process.js';
import { batchEdit } from './landing-batch-store.js';
import { recordDiagnosisNode, validatePrefixRun } from './landing-diagnosis.js';
import { assertLandingWorkerActive } from './landing-worker-context.js';
import type { CheckRun } from './work-types.js';
import type { WorkService } from './work.js';
import type { LandingBatch, BatchPrefix, LandingEntry } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

/** Repeated controller loss on the same entry (for example an OOM-killed check)
 * is a verdict about the check, not the controller; the last outcome then stands. */
export const MAX_CONTROLLER_RECOVERIES = 3;
const recoveries = (entries: readonly (LandingEntry | undefined)[]) =>
  Math.max(
    0,
    ...entries.map(
      entry =>
        entry?.infrastructureRetries?.filter(r => r.code === 'LANDING_CHECK_CONTROLLER_ENDED').length ?? 0,
    ),
  );

/** Losing a local controller is not cancellation of its durable landing goal.
 * Preparation errors, source failures, explicit cancellation and remote provider
 * recovery retain their own outcomes. A signal receipt also retains its cause. */
export function lostLandingCheckController(run: CheckRun, entries: readonly (LandingEntry | undefined)[]) {
  const serviceStop =
    run.cancellation?.reason === 'signal' && ['SIGTERM', 'SIGHUP'].includes(run.cancellation.signal ?? '');
  return (
    recoveries(entries) < MAX_CONTROLLER_RECOVERIES &&
    run.backend?.actual === 'local' &&
    run.runner.host === hostname() &&
    !run.cancelRequested &&
    !run.error &&
    (!run.cancellation || serviceStop) &&
    ((run.status === 'interrupted' && !processAlive(run.runner)) ||
      (run.status === 'cancelled' && serviceStop))
  );
}

export const batchEntries = (work: WorkService, batch: LandingBatch) =>
  batch.entryIds.map(id => work.store.select('landingEntries', id));

/** A deterministic replacement operation leaves the interrupted run immutable.
 * Ordinary check capacity still waits for any orphan process group to exit.
 * Caller has already tried content-keyed passed evidence before reaching here. */
export async function recoverLandingCheck(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  driver: LandingDriver,
) {
  const run = work.store.select('runs', prefix.runId);
  if (!run || !lostLandingCheckController(run, batchEntries(work, batch))) return;
  assertLandingWorkerActive();
  validatePrefixRun(work, batch, prefix, run);
  const replacement = await batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      const selected = saved.prefixes.find(item => item.runId === run.id);
      const current = data.runs.find(item => item.id === run.id);
      const entries = (data.landingEntries ?? []).filter(entry => batch.entryIds.includes(entry.id));
      if (!selected || !current || !lostLandingCheckController(current, entries)) return;
      if (saved.status !== 'checking') return;
      recordDiagnosisNode(data, batch, selected, undefined, current, work.store);
      selected.runId = finishChild(run.id, 'controller-recovery');
      delete selected.reservedAt;
      if (saved.confirmation?.runId === run.id) saved.confirmation.runId = selected.runId;
      delete saved.settlement;
      for (const entry of data.landingEntries ?? []) {
        if (entry.batchId !== batch.id || entry.status !== 'checking') continue;
        (entry.infrastructureRetries ??= []).push({
          at: new Date().toISOString(),
          code: 'LANDING_CHECK_CONTROLLER_ENDED',
          runId: run.id,
        });
        if (entry.runId === run.id) entry.runId = selected.runId;
        entry.reason = `Check controller ended; retrying unfinished run ${run.id} as ${selected.runId}. Original evidence is retained; cancel this landing entry to stop recovery.`;
      }
      return selected;
    },
    driver.beforePublish,
    batch.channel,
  );
  if (replacement) {
    Object.assign(prefix, replacement);
    delete prefix.reservedAt;
  }
}
