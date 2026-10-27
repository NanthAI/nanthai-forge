import { resolveLandEntry } from './land-request-identity.js';
import { prepareLandingRecords } from './landing-records-index.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
import { waitForLand, retrySingleInfrastructure, recoverLandInfrastructure } from './land-wait.js';
import { landingWorkerSignal, landingController } from './landing-worker-context.js';
import { staleLandingResult } from './landing-stale.js';
import { landingDiagnosis } from './landing-diagnosis.js';
// SPDX-License-Identifier: Apache-2.0
import { observeLandReceipt, readLandingHandle } from './land-receipt.js';
import { landingAdmission } from './landing-admission.js';
import { existsSync } from 'node:fs';
import { savedOverlapPlan, highOverlap } from './agent-overlap-plan.js';
import { join } from 'node:path';
import { LandJournal, type LandEntry, type LandSelection } from './land-journal.js';
import type { LandCommand } from './land-schema.js';
import { ForgeError, invariant } from './errors.js';
import { finishChild } from './agent-finish-journal.js';
import { withQueueSlot } from './landing-queue.js';
import { retryWorkPhase } from './work-retry.js';
import { batchEligible, enqueueLanding } from './landing-batch-store.js';
import { drainLandingBatches } from './landing-batch.js';
import { waitingDependencies, acceptedInputs } from './agent-dependencies.js';
import { currentChannelHead } from './agent-defaults.js';
import { cancelLandingEntry } from './landing-batch-cancel.js';
import { landSingle } from './land-single.js';
import type { WorkService } from './work.js';
import type { WorkView } from './work-types.js';

const waiting = (result: Record<string, unknown>) => result.status === 'waiting';
/** Pin saved inputs once, submit the whole eligible wave, then use the existing batch driver. */
async function landOnce(
  work: WorkService,
  command: LandCommand,
  selection?: LandSelection,
  cancelled?: () => boolean,
  onRun?: (runId: string) => void,
) {
  invariant(
    new Set(command.laneIds).size === command.laneIds.length,
    'BAD_ARGUMENT',
    'Select each Lane once.',
  );
  const { wait, ...request } = command;
  command = request;
  const store = work.store;
  const prepareObservation = async () => {
    const tx = store.readRecords();
    if (!tx) return;
    try {
      await prepareLandingRecords(store, tx);
    } finally {
      tx.dispose();
    }
  };
  const admitted = async () => {
    await prepareObservation();
    const journal = new LandJournal(store, command, selection);
    const response = await observeLandReceipt(store, command, journal, false);
    wakeLandingWorker(store);
    return {
      ...response,
      result: { ...response.result, ...landingAdmission(store, command.operationId, command.laneIds) },
    };
  };
  // Replays read the atomically published journal without waiting for its driver.
  if (wait === false && existsSync(join(store.directory, 'agent-land', `${command.operationId}.json`)))
    return admitted();
  const locked = await withQueueSlot(
    join(store.directory, 'land-queue', command.operationId),
    async () => {
      await prepareObservation();
      if (wait === false) return admitted();
      const journal = new LandJournal(store, command, selection);
      if (journal.state.entries.every(entry => entry.result?.settled))
        return observeLandReceipt(store, command, journal);
      journal.preflight(store, command);
      for (const entry of journal.state.entries) {
        const queued = store.select('landingEntries', entry.command.operationId);
        if (
          !entry.result?.settled &&
          entry.result?.status === 'interrupted' &&
          queued &&
          ['queued', 'checking'].includes(queued.status)
        )
          entry.result = { status: 'waiting' };
      }
      await recoverLandInfrastructure(
        work,
        journal.state.entries
          .filter(entry => !entry.sourceOperationId)
          .map(entry => entry.command.operationId),
      );
      const pins = new Map(
        journal.state.entries
          .map(entry => resolveLandEntry(store, entry))
          .filter(entry => !entry.result?.settled)
          .flatMap(entry => entry.inputs)
          .map(pin => [pin.laneId, pin.head]),
      );
      const overlap = savedOverlapPlan(
        store,
        [...pins].map(([id, head]) => ({ ...store.select('lanes', id)!, head })),
      );
      const queuedResult = (entry: LandEntry, issue?: ForgeError) => {
        const queued = store.select('landingEntries', entry.command.operationId)!;
        return {
          status:
            queued.status === 'awaiting-review'
              ? 'review-needed'
              : ['queued', 'checking'].includes(queued.status)
                ? 'waiting'
                : ['accepted', 'conflict', 'failed', 'cancelled', 'interrupted'].includes(queued.status)
                  ? queued.status
                  : 'failed',
          ...(issue && ['queued', 'checking'].includes(queued.status)
            ? { code: issue.code, message: issue.message }
            : {}),
          queueStatus: queued.status,
          batchId: queued.batchId,
          ...landingDiagnosis(store, queued),
          runId: queued.runId,
          acceptanceId: queued.acceptanceId,
          ...(queued.error ? { code: queued.error.code, message: queued.error.message } : {}),
          viewId: queued.conflictViewId ?? queued.viewId,
          ...(queued.previewDiagnostic
            ? { code: 'INTEGRATION_PREVIEW_EXCLUDED', preview: queued.previewDiagnostic }
            : {}),
          ...(queued.conflictViewId
            ? { conflict: store.select('views', queued.conflictViewId)?.details }
            : {}),
          ...(queued.reason ? { message: queued.reason } : {}),
        };
      };
      // A channel sweep can keep driving other submissions after ours settles.
      // Publish this request's outcomes at each batch boundary, not after that sweep.
      const recordSettled = () => {
        let changed = false;
        for (const entry of journal.state.entries) {
          if (entry.sourceOperationId || !entry.queued || (entry.result && !waiting(entry.result))) continue;
          const queued = store.select('landingEntries', entry.command.operationId);
          if (!queued || ['queued', 'checking'].includes(queued.status)) continue;
          entry.result = queuedResult(entry);
          changed = true;
        }
        if (changed) journal.save();
      };
      const cancelSelected = async () => {
        if (!cancelled?.()) return;
        for (const entry of journal.state.entries) {
          if (entry.sourceOperationId || (entry.result && !waiting(entry.result))) continue;
          const queued = store.select('landingEntries', entry.command.operationId);
          if (queued && ['queued', 'checking'].includes(queued.status))
            await cancelLandingEntry(work, queued.id);
          if (!queued) entry.result = { status: 'cancelled' };
        }
        journal.save();
      };
      const phase = (input: unknown) => {
        const reconcileComposition = (input as { action?: string }).action === 'compose';
        return retryWorkPhase(
          command.operationId,
          () =>
            work.dispatch(
              input,
              reconcileComposition ? store.revision() : store.locked(() => store.revision()),
              { keepOpen: command.keepOpen, reconcileComposition },
            ),
          ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'],
        );
      };
      const recordError = (entry: LandEntry, error: unknown) => {
        if (!(error instanceof ForgeError) || error.code === 'LANDING_WORKER_STOPPED') throw error;
        const stale = staleLandingResult(error);
        entry.result = stale
          ? { ...stale, status: 'failed' }
          : {
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
        await cancelSelected();
        let submitted = false;
        const deferred = new Set<string>();
        for (const [index, entry] of journal.state.entries.entries()) {
          if (entry.sourceOperationId || (entry.result && !waiting(entry.result))) continue;
          if (entry.queued) continue;
          const newer = entry.inputs.flatMap(pin => {
            const lane = store.select('lanes', pin.laneId);
            return lane && lane.head !== pin.head ? [{ laneId: pin.laneId, head: lane.head }] : [];
          });
          if (newer.length) {
            entry.result = {
              status: 'superseded',
              code: 'LANDING_SUPERSEDED',
              message: `Desired head superseded by ${newer.map(pin => `Lane ${pin.laneId} head ${pin.head}`).join(', ')}.`,
            };
            journal.save();
            continue;
          }
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
              (!selection && batchEligible(work, entry.command, view))
            ) {
              const predecessor = journal.state.entries.slice(0, index).find(
                prior =>
                  prior.viewId &&
                  (!prior.result || waiting(prior.result)) &&
                  highOverlap(
                    overlap,
                    prior.inputs.map(pin => pin.laneId),
                    entry.inputs.map(pin => pin.laneId),
                  ),
              );
              if (predecessor) {
                deferred.add(entry.command.operationId);
                entry.result = { status: 'waiting', overlapAfter: predecessor.inputs.map(pin => pin.laneId) };
                continue;
              }

              await enqueueLanding(work, entry.command, view, journal.state.landingPins);
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
            await drainLandingBatches(
              work,
              command.channel,
              command.waitMs,
              cancelSelected,
              undefined,
              recordSettled,
            );
          } catch (error) {
            if (
              !(
                error instanceof ForgeError &&
                ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(error.code)
              )
            )
              throw error;
            drainIssue = error;
          }
        }
        await recoverLandInfrastructure(
          work,
          journal.state.entries
            .filter(entry => !entry.sourceOperationId)
            .map(entry => entry.command.operationId),
        );
        for (const entry of journal.state.entries) {
          const queued = store.select('landingEntries', entry.command.operationId);
          if (
            !entry.result?.settled &&
            entry.result?.status === 'interrupted' &&
            queued &&
            ['queued', 'checking'].includes(queued.status)
          )
            entry.result = { status: 'waiting' };
        }
        let progressed = false;
        for (const [index, entry] of journal.state.entries.entries()) {
          if (entry.sourceOperationId || (entry.result && !waiting(entry.result))) continue;
          const exhausted =
            selection &&
            journal.state.entries.find(prior => prior.result?.status === 'retry-exhausted')?.result;
          if (exhausted) {
            entry.result = {
              status: 'retry-exhausted',
              code: exhausted.code,
              message: 'Existing finish retry budget exhausted before this Lane was attempted.',
            };
            journal.save();
            continue;
          }
          if (deferred.has(entry.command.operationId)) continue;
          if (
            !entry.queued &&
            journal.state.entries.slice(0, index).some(
              prior =>
                prior.viewId &&
                prior.result &&
                waiting(prior.result) &&
                highOverlap(
                  overlap,
                  prior.inputs.map(pin => pin.laneId),
                  entry.inputs.map(pin => pin.laneId),
                ),
            )
          )
            continue;
          try {
            if (entry.queued) {
              entry.result = queuedResult(entry, drainIssue);
            } else if (!entry.result && entry.viewId) {
              entry.result = await landSingle(work, entry, command, phase, () => journal.save(), {
                cancelled: () => cancelled?.() ?? false,
                onRun: runId => onRun?.(runId),
                // Inherit finish's existing operation budget; ordinary land keeps its protocol.
                retry: () =>
                  !selection ||
                  journal.state.entries.reduce((n, item) => n + (item.single?.attempt ?? 0), 0) <
                    (selection.finish.maxRetries ?? 3),
              });
            }
            if (landingController() && !entry.queued) retrySingleInfrastructure(work, entry);
            if (entry.result && !waiting(entry.result)) progressed = true;
            journal.save();
          } catch (error) {
            recordError(entry, error);
          }
        }
        if (!progressed && !submitted) break;
        if (journal.state.entries.every(entry => entry.result && !waiting(entry.result))) break;
      }
      return observeLandReceipt(store, command, journal);
    },
    { anchor: store.directory, phase: 'landing selected Lanes' },
  );
  if ('value' in locked) return locked.value;
  throw new ForgeError(
    'WORK_BUSY',
    `Replay land operation ${command.operationId}; its driver is still running.`,
  );
}

export const driveLand = landOnce;

/** Controllers alone execute the retained state machine. A waiting client only
 * reads the same durable handle and may disappear without changing its outcome. */
export async function land(...args: Parameters<typeof landOnce>) {
  const [work, command, selection] = args;
  if (landingController() || selection) {
    if (command.wait === true && !landingWorkerSignal())
      return waitForLand(work, () => landOnce(...args), command.operationId);
    return landOnce(...args);
  }
  await landOnce(work, { ...command, wait: false });
  const observe = () => readLandingHandle(work.store, command.operationId);
  if (command.wait === true) return waitForLand(work, observe, command.operationId);
  return observe();
}
