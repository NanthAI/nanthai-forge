// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { LandJournal, type LandEntry } from './land-journal.js';
import type { LandCommand } from './land-schema.js';
import { ForgeError, invariant } from './errors.js';
import { finishChild } from './agent-finish-journal.js';
import { withQueueSlot } from './landing-queue.js';
import { retryWorkPhase } from './work-retry.js';
import { batchEligible, enqueueLanding } from './landing-batch-store.js';
import { drainLandingBatches } from './landing-batch.js';
import { waitingDependencies, acceptedInputs } from './agent-dependencies.js';
import { currentChannelHead } from './agent-defaults.js';
import { landSingle } from './land-single.js';
import type { WorkService } from './work.js';
import type { WorkView } from './work-types.js';

const waiting = (result: Record<string, unknown>) => result.status === 'waiting';
/** Pin saved inputs once, submit the whole eligible wave, then use the existing batch driver. */
export async function land(work: WorkService, command: LandCommand) {
  invariant(
    new Set(command.laneIds).size === command.laneIds.length,
    'BAD_ARGUMENT',
    'Select each Lane once.',
  );
  const store = work.store;
  const locked = await withQueueSlot(
    join(store.directory, 'land-queue', command.operationId),
    async () => {
      const journal = new LandJournal(store, command);
      const phase = (input: unknown) =>
        retryWorkPhase(command.operationId, () =>
          work.dispatch(input, store.revision(), { keepOpen: command.keepOpen }),
        );
      const recordError = (entry: LandEntry, error: unknown) => {
        if (!(error instanceof ForgeError)) throw error;
        entry.result = {
          status: ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(error.code)
            ? 'waiting'
            : error.code === 'REVIEW_REQUIRED'
              ? 'review-needed'
              : 'failed',
          code: error.code,
          message: error.message,
        };
        journal.save();
      };
      // Dependencies can become ready as another wave lands; never drain after just one submission.
      for (let pass = 0; pass <= journal.state.entries.length; pass++) {
        let submitted = false;
        for (const entry of journal.state.entries) {
          if (entry.result && !waiting(entry.result)) continue;
          if (entry.queued) continue;
          const dependencies = waitingDependencies(
            store,
            entry.inputs.map(pin => pin.laneId),
            command.channel,
          );
          if (dependencies.length) {
            entry.result = { status: 'waiting', dependencies };
            continue;
          }
          delete entry.result;
          try {
            if (!entry.viewId) {
              const first = store.select('lanes', entry.command.laneId)!;
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
              journal.save();
            }
            const view = store.select('views', entry.viewId)!;
            if (view.status !== 'clean' || !view.head) {
              entry.result = { status: 'conflict', viewId: view.id };
              journal.save();
              continue;
            }
            const main = currentChannelHead(store, command.channel);
            if (main && acceptedInputs(store, entry.inputs, command.channel, main)) {
              entry.result = { status: 'accepted', alreadyAccepted: true };
              journal.save();
              continue;
            }
            if (
              store.select('landingEntries', entry.command.operationId) ||
              batchEligible(work, entry.command, view)
            ) {
              await enqueueLanding(work, entry.command, view);
              entry.queued = true;
              journal.save();
              submitted = true;
            }
          } catch (error) {
            recordError(entry, error);
          }
        }
        let drainIssue: ForgeError | undefined;
        if (journal.state.entries.some(entry => entry.queued && (!entry.result || waiting(entry.result)))) {
          try {
            await drainLandingBatches(work, command.channel, command.waitMs);
          } catch (error) {
            if (!(
              error instanceof ForgeError &&
              ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(error.code)
            ))
              throw error;
            drainIssue = error;
          }
        }
        let progressed = false;
        for (const entry of journal.state.entries) {
          if (entry.result && !waiting(entry.result)) continue;
          try {
            if (entry.queued) {
              const queued = store.select('landingEntries', entry.command.operationId)!;
              entry.result = {
                status:
                  queued.status === 'awaiting-review'
                    ? 'review-needed'
                    : ['queued', 'checking'].includes(queued.status)
                      ? 'waiting'
                      : ['accepted', 'conflict', 'failed'].includes(queued.status)
                        ? queued.status
                        : 'failed',
                ...(drainIssue && ['queued', 'checking'].includes(queued.status)
                  ? { code: drainIssue.code, message: drainIssue.message }
                  : {}),
                queueStatus: queued.status,
                batchId: queued.batchId,
                runId: queued.runId,
                acceptanceId: queued.acceptanceId,
                viewId: queued.conflictViewId ?? queued.viewId,
                ...(queued.reason ? { message: queued.reason } : {}),
              };
            } else if (!entry.result && entry.viewId) {
              entry.result = await landSingle(work, entry, command, phase, () => journal.save());
            }
            if (entry.result && !waiting(entry.result)) progressed = true;
            journal.save();
          } catch (error) {
            recordError(entry, error);
          }
        }
        if (!progressed && !submitted) break;
        if (journal.state.entries.every(entry => entry.result && !waiting(entry.result))) break;
      }
      const entries = journal.state.entries.map(entry => ({
        operationId: entry.command.operationId,
        message: entry.command.message,
        inputs: entry.inputs,
        status: String(entry.result?.status ?? 'waiting'),
        ...(entry.result ?? { status: 'waiting' }),
      }));
      const counts: Record<string, number> = {};
      for (const entry of entries) {
        const status = String(entry.status);
        counts[status] = (counts[status] ?? 0) + entry.inputs.length;
      }
      return {
        revision: store.revision(),
        result: {
          operationId: command.operationId,
          complete: entries.every(entry => entry.status === 'accepted'),
          terminal: entries.every(entry => entry.status !== 'waiting'),
          counts,
          entries,
          replay: {
            command,
            shell: `nforge agent '${store.root.replaceAll("'", "'\\''")}' land '${JSON.stringify(command).replaceAll("'", "'\\''")}'`,
          },
        },
      };
    },
    { anchor: store.directory, phase: 'landing selected Lanes' },
  );
  if ('value' in locked) return locked.value;
  throw new ForgeError(
    'WORK_BUSY',
    `Replay land operation ${command.operationId}; its driver is still running.`,
  );
}
