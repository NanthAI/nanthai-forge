// SPDX-License-Identifier: Apache-2.0
import { batchEntries, lostLandingCheckController } from './landing-check-recovery.js';
import { admitLandingCheck } from './landing-check-admission.js';
import { waitForAgentRun } from './agent-run-observer.js';
import { validatePrefixRun, diagnosticStatus } from './landing-diagnosis.js';
import { pendingActionsInfra } from './github-actions-infra.js';
import { gateCheck } from './check-reuse-key.js';
import { planLandingTrain } from './landing-train-plan.js';
import { failureSummary } from './agent-run-failure.js';
import { batchEdit } from './landing-batch-store.js';
import { checkingWait, landingWait } from './landing-waiting.js';
import type { WorkService } from './work.js';
import type { LandingBatch } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

/** Solo admission is not a prefix search and cannot accept source. */
export async function evaluateSoloAdmission(
  work: WorkService,
  batch: LandingBatch,
  driver: LandingDriver,
  waitMs?: number,
) {
  const prefix = batch.prefixes[0];
  // Composition may have resolved this entry as an already-landed no-op/conflict.
  if (!prefix || work.store.select('landingEntries', batch.entryIds[0]!)?.status !== 'checking') {
    await batchEdit(
      work,
      batch.id,
      data => {
        data.landingBatches!.find(item => item.id === batch.id)!.status = 'completed';
      },
      driver.beforePublish,
      batch.channel,
    );
    return true;
  }
  if (!(await admitLandingCheck(work, batch, prefix, driver, waitMs))) return false;
  let run = work.store.select('runs', prefix.runId)!;
  if (['queued', 'preparing', 'running', 'interrupted'].includes(run.status)) {
    await waitForAgentRun(work.store, prefix.runId, waitMs);
    run = work.store.select('runs', prefix.runId)!;
  }
  validatePrefixRun(work, batch, prefix, run);
  if (lostLandingCheckController(run, batchEntries(work, batch))) return false;
  if (['queued', 'preparing', 'running'].includes(run.status) || pendingActionsInfra(run)) {
    await batchEdit(
      work,
      batch.id,
      data => {
        const entry = data.landingEntries!.find(item => item.id === batch.entryIds[0])!;
        if (entry.status === 'checking') {
          entry.runId = run.id;
          entry.waitingFor = checkingWait(data, entry);
        }
      },
      driver.beforePublish,
      batch.channel,
    );
    return false;
  }
  const status = diagnosticStatus(run);
  const full = gateCheck(run) && (!run.checkSelection || run.checkSelection.scope === 'full');
  const details = run.failureSummary ?? (status === 'failed' ? failureSummary(work.store, run) : '');
  await batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      const entry = data.landingEntries!.find(item => item.id === batch.entryIds[0])!;
      if (saved.status !== 'checking') return;
      if (entry.status !== 'checking') {
        saved.status = 'completed';
        return;
      }
      entry.runId = run.id;
      if (status === 'passed' && full) {
        const train = planLandingTrain(work.store, data, batch.channel);
        if (
          !data.landingEntries!.some(
            other =>
              other.id !== entry.id &&
              other.channel === batch.channel &&
              other.status === 'queued' &&
              !train.waits.some(wait => wait.entryId === other.id),
          )
        ) {
          // With no eligible wave to join, this exact checked singleton can land
          // directly. Overlapping waiters cannot advance until it does.
          saved.settlement = { cancelledAt: -1, passingViewId: prefix.viewId };
          entry.waitingFor = checkingWait(data, entry);
          return;
        }
        saved.status = 'completed';
        entry.status = 'queued';
        entry.waitingFor = landingWait(
          data,
          'batch-order',
          'Solo check passed; waiting for a compatible batch.',
        );
        return;
      }
      saved.status = 'completed';
      entry.status = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'interrupted';
      entry.terminalAt = new Date().toISOString();
      delete entry.waitingFor;
      entry.reason =
        status === 'failed'
          ? `Solo check failed on base ${batch.base}; run ${run.id}.${details ? `\n${details}` : ''}`
          : status === 'passed'
            ? `Solo admission requires a full gate check; run ${run.id} was partial or scoped.`
            : `Solo check ${status}; run ${run.id}. ${run.error?.message ?? run.details}`;
    },
    driver.beforePublish,
    batch.channel,
  );
  return true;
}
