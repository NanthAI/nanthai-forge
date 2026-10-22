// SPDX-License-Identifier: Apache-2.0
import { waitForAgentRun } from './agent-run-observer.js';
import { retryWorkPhase } from './work-retry.js';
import { batchEdit } from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { CheckRun } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

/** Remote failure attribution checks all proper prefixes in one parallel round.
 * Local fallback halves the prefix interval and never lands an unchecked subset. */
export async function passingPrefix(
  prefixes: BatchPrefix[],
  mode: LandingBatch['mode'] | (() => LandingBatch['mode']),
  check: (prefix: BatchPrefix) => Promise<CheckRun['status']>,
): Promise<{
  passing?: BatchPrefix | undefined;
  culprit?: BatchPrefix | undefined;
  stopped?: CheckRun['status'];
}> {
  if (!prefixes.length) return {};
  const full = prefixes.at(-1)!;
  const status = await check(full);
  if (status === 'passed') return { passing: full };
  if (status !== 'failed') return { stopped: status };
  let index = -1;
  if ((typeof mode === 'function' ? mode() : mode) === 'parallel') {
    const outcomes = await Promise.all(prefixes.slice(0, -1).map(check));
    const stopped = outcomes.find(status => status !== 'passed' && status !== 'failed');
    if (stopped) return { stopped };
    index = outcomes.lastIndexOf('passed');
  } else {
    let low = 0,
      high = prefixes.length - 2;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2),
        status = await check(prefixes[mid]!);
      if (status !== 'passed' && status !== 'failed') return { stopped: status };
      if (status === 'passed') {
        index = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    // Retain the exact failing run for the entry immediately after the passing prefix.
    const culprit = prefixes[index + 1]!;
    if (culprit !== full) await check(culprit);
  }
  return { passing: prefixes[index], culprit: prefixes[index + 1] };
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
    async prefix => {
      const first = work.store.select('landingEntries', batch.entryIds[0]!)!;
      const recorded = work.store.select('runs', prefix.runId);
      // Completed exact-plan evidence needs no dispatch or controller replay.
      if (!recorded || ['queued', 'preparing', 'running', 'interrupted'].includes(recorded.status)) {
        await retryWorkPhase(prefix.runId, () =>
          work.dispatch(
            {
              action: 'run-check',
              operationId: prefix.runId,
              viewId: prefix.viewId,
              expectedHead: prefix.head,
              checkId: first.checkId,
              expectedDefinition: first.definition,
              expectedEnvironment: batch.environment?.fingerprint ?? first.environment,
            },
            work.store.revision(),
            { beforePublish: driver.beforePublish },
          ),
        );
        await waitForAgentRun(work.store, prefix.runId, waitMs);
      }
      const run = work.store.select('runs', prefix.runId)!;
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
      return run.status;
    },
  );
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
        ...(outcome.culprit ? { culpritViewId: outcome.culprit.viewId } : {}),
        ...(stopped && stopped !== 'passed' ? { stopped } : {}),
      };
    },
    driver.beforePublish,
  );
  return true;
}
