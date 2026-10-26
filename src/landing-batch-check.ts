import { batchEntries, lostLandingCheckController } from './landing-check-recovery.js';
import { reserveBoundaryConfirmation } from './landing-confirmation.js';
import { checkingWait } from './landing-waiting.js';
import { admitLandingCheck } from './landing-check-admission.js';
import {
  retainDiagnosisNode,
  recordDiagnosisNode,
  validatePrefixRun,
  diagnosticStatus,
} from './landing-diagnosis.js';
import { pendingActionsInfra } from './github-actions-infra.js';
import { evaluateSoloAdmission } from './landing-solo-evaluation.js';
// SPDX-License-Identifier: Apache-2.0
import { waitForAgentRun } from './agent-run-observer.js';
import { batchEdit } from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { CheckRun } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

/** Remote diagnosis checks all proper prefixes in one parallel round.
 * Local fallback halves the prefix interval and never lands an unchecked subset. */
export async function passingPrefix(
  prefixes: BatchPrefix[],
  mode: LandingBatch['mode'] | (() => LandingBatch['mode']),
  check: (prefix: BatchPrefix, parent?: BatchPrefix) => Promise<CheckRun['status']>,
): Promise<{
  passing?: BatchPrefix | undefined;
  failing?: BatchPrefix | undefined;
  /** Compatibility alias for the observed failing boundary prefix. */
  culprit?: BatchPrefix | undefined;
  stopped?: CheckRun['status'];
}> {
  if (!prefixes.length) return {};
  const full = prefixes.at(-1)!;
  const status = await check(full);
  if (status === 'passed') return { passing: full };
  if (status !== 'failed') return { stopped: status };
  // One evaluation observes each exact run once, including the failing boundary.
  const observed = new Map<BatchPrefix, CheckRun['status']>([[full, status]]);
  const probe = async (prefix: BatchPrefix, parent: BatchPrefix) => {
    const known = observed.get(prefix);
    if (known) return known;
    const status = await check(prefix, parent);
    observed.set(prefix, status);
    return status;
  };
  let index = -1;
  if ((typeof mode === 'function' ? mode() : mode) === 'parallel') {
    const outcomes = await Promise.all(prefixes.slice(0, -1).map(prefix => probe(prefix, full)));
    const stopped = outcomes.find(status => status !== 'passed' && status !== 'failed');
    if (stopped) return { stopped };
    index = outcomes.lastIndexOf('passed');
  } else {
    let low = 0,
      high = prefixes.length - 2,
      parent = full;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2),
        status = await probe(prefixes[mid]!, parent);
      parent = prefixes[mid]!;
      if (status !== 'passed' && status !== 'failed') return { stopped: status };
      if (status === 'passed') {
        index = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    // This is an observed failing combination. Halving does not establish
    // monotonicity, the longest pass, or a standalone/minimal failing Lane.
    const failing = prefixes[index + 1]!;
    const status = await probe(failing, full);
    if (status !== 'failed') return { stopped: status };
  }
  return { passing: prefixes[index], failing: prefixes[index + 1], culprit: prefixes[index + 1] };
}
export const cancellationBoundary = (work: WorkService, batch: LandingBatch) =>
  batch.prefixes.findIndex(
    prefix => work.store.select('landingEntries', prefix.entryIds.at(-1)!)?.status === 'cancelled',
  );

export async function evaluateBatch(
  work: WorkService,
  batch: LandingBatch,
  driver: LandingDriver,
  waitMs?: number,
) {
  if (batch.admission) return evaluateSoloAdmission(work, batch, driver, waitMs);
  const cancelledAt = cancellationBoundary(work, batch);
  let settled = false;
  const outcome = await passingPrefix(
    cancelledAt < 0 ? batch.prefixes : batch.prefixes.slice(0, cancelledAt),
    () => batch.mode,
    async (prefix, parent) => {
      if (!(await admitLandingCheck(work, batch, prefix, driver, waitMs, parent))) return 'queued';
      const recorded = work.store.select('runs', prefix.runId)!;
      if (['queued', 'preparing', 'running', 'interrupted'].includes(recorded.status))
        await waitForAgentRun(work.store, prefix.runId, waitMs);
      const run = work.store.select('runs', prefix.runId)!;
      validatePrefixRun(work, batch, prefix, run);
      // Recovery runs on the next admission, after checking for a passed twin.
      if (lostLandingCheckController(run, batchEntries(work, batch))) return 'queued';
      // A sole failed Candidate has no proper prefix to diagnose or accept.
      // Publish its exact evidence and terminal entry together, freeing the
      // queue before unrelated acceptance/lifecycle work can delay it.
      if (
        batch.entryIds.length === 1 &&
        batch.prefixes.length === 1 &&
        !batch.parentId &&
        cancelledAt < 0 &&
        diagnosticStatus(run) === 'failed'
      ) {
        settled = await batchEdit(
          work,
          batch.id,
          data => {
            const saved = data.landingBatches!.find(item => item.id === batch.id)!;
            const entry = data.landingEntries!.find(item => item.id === batch.entryIds[0])!;
            if (
              saved.status !== 'checking' ||
              cancellationBoundary(work, saved) !== cancelledAt ||
              entry.status !== 'checking'
            )
              return false;
            recordDiagnosisNode(data, batch, prefix, parent, run);
            if (saved.confirmation) {
              const run = data.runs.find(run => run.id === saved.confirmation!.runId);
              saved.confirmation.verdict =
                run?.status === 'passed'
                  ? 'flake'
                  : run && diagnosticStatus(run) === 'failed'
                    ? 'confirmed'
                    : 'inconclusive';
            }
            saved.settlement = { cancelledAt, failingViewId: prefix.viewId, culpritViewId: prefix.viewId };
            saved.status = 'completed';
            if (saved.timing) {
              saved.timing.settlementStartedAt ??= new Date().toISOString();
              saved.timing.settledAt ??= new Date().toISOString();
            }
            saved.culpritId = entry.id;
            entry.status = 'failed';
            entry.terminalAt = new Date().toISOString();
            entry.runId = run.id;
            entry.reason = `Observed failing prefix of 1 landing entries on base ${batch.base}; run ${run.id}. This does not establish a standalone or minimal failing Lane.`;
            return true;
          },
          driver.beforePublish,
          batch.channel,
        );
        if (settled) return 'failed';
      }
      await retainDiagnosisNode(work, batch, prefix, parent, driver, run);
      if (run.backend?.actual === 'local' && batch.mode === 'parallel') {
        batch.mode = 'halving';
        await batchEdit(
          work,
          batch.id,
          data => {
            data.landingBatches!.find(item => item.id === batch.id)!.mode = 'halving';
          },
          driver.beforePublish,
          batch.channel,
        );
      }
      return diagnosticStatus(run);
    },
  );
  if (settled) return true;
  if (await reserveBoundaryConfirmation(work, batch, outcome.failing?.viewId, driver)) return true;
  const infraRun = batch.prefixes
    .map(prefix => work.store.select('runs', prefix.runId))
    .find(run => run && pendingActionsInfra(run));
  if (outcome.stopped === 'interrupted' && infraRun) {
    // Keep the batch resumable. An observation window ending is no evidence against source.
    await batchEdit(
      work,
      batch.id,
      data => {
        for (const entry of data.landingEntries!.filter(
          entry => entry.batchId === batch.id && entry.status === 'checking',
        ))
          entry.runId = infraRun.id;
      },
      driver.beforePublish,
      batch.channel,
    );
    return false;
  }
  const stopped = outcome.stopped;
  if (stopped === 'queued' || stopped === 'preparing' || stopped === 'running') return false;
  await batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      // A concurrent cancellation changes the applicable prefix; evaluate it again.
      if (cancellationBoundary(work, saved) !== cancelledAt) return;
      if (saved.confirmation) {
        const run = data.runs.find(run => run.id === saved.confirmation!.runId);
        saved.confirmation.verdict =
          run?.status === 'passed'
            ? 'flake'
            : run && diagnosticStatus(run) === 'failed'
              ? 'confirmed'
              : 'inconclusive';
      }
      if (saved.timing) saved.timing.settlementStartedAt ??= new Date().toISOString();
      saved.settlement = {
        cancelledAt,
        ...(outcome.passing ? { passingViewId: outcome.passing.viewId } : {}),
        ...(outcome.failing
          ? { failingViewId: outcome.failing.viewId, culpritViewId: outcome.failing.viewId }
          : {}),
        ...(stopped && stopped !== 'passed' ? { stopped } : {}),
      };
      for (const entry of data.landingEntries ?? [])
        if (entry.batchId === batch.id && entry.status === 'checking')
          entry.waitingFor = checkingWait(data, entry);
    },
    driver.beforePublish,
    batch.channel,
  );
  return true;
}
