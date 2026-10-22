// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { pendingLands, saveLandJournal } from './land-journal.js';
import { withQueueSlot } from './landing-queue.js';
import { waitingDependencies } from './agent-dependencies.js';
import { finishChild } from './agent-finish-journal.js';
import { retryWorkPhase } from './work-retry.js';
import { batchEligible, enqueueLanding } from './landing-batch-store.js';
import { landSingle } from './land-single.js';
import { assertLandingWorkerActive } from './landing-worker-context.js';
import type { WorkService } from './work.js';
import type { WorkView } from './work-types.js';

/** Older land journals lack the parent CLI command, but already retain every
 * selected child command/input and single-attempt cursor. Recover those exact
 * pins under the original parent slot without inventing a new request/hash. */
export async function resumeLegacyLand(work: WorkService, operationId: string) {
  return withQueueSlot(
    join(work.store.directory, 'land-queue', operationId),
    async () => {
      const retained = pendingLands(work.store).find(j => j.operationId === operationId);
      if (!retained) return;
      const save = () => saveLandJournal(work.store, retained.path, retained.state);
      for (const entry of retained.state.entries) {
        assertLandingWorkerActive();
        if (entry.result && entry.result.status !== 'waiting') continue;
        const channel = entry.command.accept!.channel;
        if (
          waitingDependencies(
            work.store,
            entry.inputs.map(pin => pin.laneId),
            channel,
          ).length
        )
          continue;
        const phase = (input: unknown) =>
          retryWorkPhase(operationId, () =>
            work.dispatch(input, work.store.revision(), {
              keepOpen: entry.command.keepOpen,
              reconcileComposition: true,
            }),
          );
        const queued = work.store.select('landingEntries', entry.command.operationId);
        if (queued) {
          if (!['queued', 'checking'].includes(queued.status)) {
            entry.result = { status: queued.status, runId: queued.runId, acceptanceId: queued.acceptanceId };
            save();
          }
          continue;
        }
        delete entry.result;
        if (!entry.viewId) {
          const first = work.store.select('lanes', entry.command.laneId)!;
          const view = (
            await phase({
              action: 'compose',
              operationId: finishChild(entry.command.operationId, 'land-compose'),
              intentId: first.intentId,
              inputs: entry.inputs,
              dependencies: entry.command.dependencies,
            })
          ).result as WorkView;
          entry.viewId = view.id;
          save();
        }
        const view = work.store.select('views', entry.viewId)!;
        if (view.status !== 'clean' || !view.head) {
          entry.result = { status: 'conflict', viewId: view.id };
          save();
          continue;
        }
        if (batchEligible(work, entry.command, view)) {
          await enqueueLanding(work, entry.command, view);
          entry.queued = true;
          save();
          continue;
        }
        entry.result = await landSingle(
          work,
          entry,
          {
            action: 'land',
            operationId,
            laneIds: entry.inputs.map(pin => pin.laneId),
            channel,
            ...(entry.command.keepOpen === undefined ? {} : { keepOpen: entry.command.keepOpen }),
          },
          phase,
          save,
          {
            retry: () =>
              !retained.selection ||
              retained.state.entries.reduce((n, e) => n + (e.single?.attempt ?? 0), 0) <
                (retained.selection.finish.maxRetries ?? 3),
          },
        );
        save();
      }
    },
    { anchor: work.store.directory },
  );
}
