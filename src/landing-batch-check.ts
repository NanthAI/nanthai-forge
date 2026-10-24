import { admitLandingCheck } from './landing-check-admission.js';
import { retainDiagnosisNode, validatePrefixRun, diagnosticStatus } from './landing-diagnosis.js';
import { pendingActionsInfra } from './github-actions-infra.js';
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
  const cancelledAt = cancellationBoundary(work, batch);
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
        );
      }
      return diagnosticStatus(run);
    },
  );
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
      saved.settlement = {
        cancelledAt,
        ...(outcome.passing ? { passingViewId: outcome.passing.viewId } : {}),
        ...(outcome.failing
          ? { failingViewId: outcome.failing.viewId, culpritViewId: outcome.failing.viewId }
          : {}),
        ...(stopped && stopped !== 'passed' ? { stopped } : {}),
      };
    },
    driver.beforePublish,
  );
  return true;
}
