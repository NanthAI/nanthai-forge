// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import { readAttemptLocks } from './landing-attempt-timing.js';
import { readLandCheckProgress } from './land-check-progress.js';
import { finishChild } from './finish-child.js';
import type { LandEntry } from './land-journal.js';
import type { LandingBatch } from './landing-batch-types.js';
import type { WorkStore } from './work-store.js';
/** Every batch/requeue and proper diagnosis prefix keeps its own boundaries.
 * Missing historical timestamps stay absent rather than borrowing another try. */
export function readLandingAttempts(store: WorkStore, entryId: string, journal?: LandEntry) {
  const tx = store.readRecords();
  const batches = tx
    ? tx.manifest.collections.landingBatches
      ? allRecords<LandingBatch>(store, 'landingBatches')
      : []
    : (store.load().landingBatches ?? []);
  const batched = batches
    .filter(batch => batch.entryIds.includes(entryId))
    .map(batch => ({
      attemptId: finishChild(entryId, `landing-attempt:${batch.id}`),
      batchId: batch.id,
      status: batch.status,
      ...batch.timing,
      writerLocks: readAttemptLocks(store, batch.id),
      checks: batch.prefixes
        .filter(prefix => prefix.entryIds.includes(entryId))
        .map(prefix => {
          const run = store.select('runs', prefix.runId);
          const progress = run ? readLandCheckProgress(store.directory, run.id, false) : undefined;
          const node = batch.diagnosis?.nodes.find(node => node.id === prefix.runId);
          const reservationAt = prefix.reservedAt ?? run?.queuedAt,
            ciStartedAt = progress?.ciAt ?? (run?.backend?.actual === 'local' ? run.startedAt : undefined),
            ciEndedAt = progress?.checkedAt ?? run?.endedAt;
          return {
            runId: prefix.runId,
            viewId: prefix.viewId,
            ...(reservationAt ? { reservationAt } : {}),
            ...(ciStartedAt ? { ciStartedAt } : {}),
            ...(ciEndedAt ? { ciEndedAt } : {}),
            ...(node?.probeAt ? { diagnosisProbeAt: node.probeAt } : {}),
          };
        }),
    }));
  const singles = [...(journal?.singleAttempts ?? []), ...(journal?.single ? [journal.single] : [])].map(
    attempt => {
      const attemptId = finishChild(entryId, `single:${attempt.attempt}:attempt`);
      const runId = finishChild(entryId, `single:${attempt.attempt}:run`);
      const run = store.select('runs', runId);
      const progress = run ? readLandCheckProgress(store.directory, runId, false) : undefined;
      const reservationAt = attempt.timing?.checkReservedAt ?? run?.queuedAt,
        ciStartedAt = progress?.ciAt ?? (run?.backend?.actual === 'local' ? run.startedAt : undefined),
        ciEndedAt = progress?.checkedAt ?? run?.endedAt;
      return {
        attemptId,
        ...attempt.timing,
        writerLocks: readAttemptLocks(store, attemptId),
        checks: [
          {
            runId,
            ...(attempt.viewId ? { viewId: attempt.viewId } : {}),
            ...(reservationAt ? { reservationAt } : {}),
            ...(ciStartedAt ? { ciStartedAt } : {}),
            ...(ciEndedAt ? { ciEndedAt } : {}),
          },
        ],
      };
    },
  );
  return [...batched, ...singles];
}
