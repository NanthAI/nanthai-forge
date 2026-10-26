import { recordLandingWaits } from './landing-waiting.js';
import { landingRecords } from './landing-records.js';
import { observeWorkProgress } from './work-progress.js';
import { landingWorkerSignal } from './landing-worker-context.js';
// SPDX-License-Identifier: Apache-2.0
import { withQueueSlot } from './landing-queue.js';
import { batchDirectory, batchEdit, composeBatch, landingShape, selectBatch } from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { LandingBatch } from './landing-batch-types.js';
import { claimLandingDriver } from './landing-driver.js';
import { advanceLandingBatch } from './landing-batch-step.js';
import { completeAlreadyOnMain } from './landing-noop.js';
export { passingPrefix } from './landing-batch-check.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Give a burst a moment to arrive before the first remote check starts. */
async function batchWindow(work: WorkService, channel: string) {
  for (;;) {
    const data = landingRecords(work.store, channel);
    if (
      data.landingBatches?.some(
        batch => batch.channel === channel && ['composing', 'checking'].includes(batch.status),
      )
    )
      return; // Recovery adopts the recorded batch immediately.
    const queued = (data.landingEntries ?? []).filter(
      entry => entry.channel === channel && entry.status === 'queued',
    );
    const first = queued[0] && work.store.select('checks', queued[0].checkId);
    if (!first) return;
    const shape = landingShape(work, first),
      oldest = Math.min(...queued.map(entry => Date.parse(entry.arrivedAt)));
    const left = oldest + shape.windowMs - Date.now();
    if (left <= 0 || queued.length >= shape.maxBatch) return;
    await sleep(Math.min(50, left));
  }
}
/** Finite sweep; another finish or land-ready adopts any incomplete recorded batch. On a remote
 * runner, batches arriving while checks run are stacked on the newest one and checked at once. */
export async function drainLandingBatches(
  work: WorkService,
  channel: string,
  waitMs?: number,
  beforeAccept?: () => Promise<void>,
  onFailure?: (batch: LandingBatch) => void,
  onSettled?: () => void,
) {
  return withQueueSlot(
    batchDirectory(work, channel),
    async () => {
      const driver = await claimLandingDriver(work, channel);
      // Recover Lane completion of entries found already on main before a restart.
      await completeAlreadyOnMain(work, channel);
      const seen = new Set<string>(),
        started = new Set<string>(),
        running = new Map<string, Promise<boolean>>();
      const observe = () => {
        const data = landingRecords(work.store, channel);
        for (const entry of data.landingEntries ?? [])
          if (entry.channel === channel && ['queued', 'checking'].includes(entry.status)) seen.add(entry.id);
        return data;
      };
      let halted = false,
        failure: { error: unknown; batch: LandingBatch } | undefined,
        launched = 0;
      observe();
      for (;;) {
        const observed = observe();
        const pending = observed.landingEntries?.find(
          entry => entry.channel === channel && entry.status === 'queued',
        );
        const check = pending && observed.checks.find(check => check.id === pending.checkId);
        const shape = check && landingShape(work, check);
        const recoverable = observed.landingBatches?.some(
          batch =>
            batch.channel === channel &&
            ['composing', 'checking'].includes(batch.status) &&
            !started.has(batch.id),
        );
        // A saturated runner cannot admit another batch. Polling selectBatch
        // anyway saves unchanged Work every turn, invalidating other Lanes'
        // prepared commits for the entire duration of the running check.
        const canSelect = !running.size || recoverable || (shape?.remote && running.size < shape.concurrency);
        let batch: LandingBatch | undefined;
        // Terminal entries may leave an unfinished batch with no live entries
        // after a crash in composition/cancellation. Adopt that batch as well.
        if (!halted && (recoverable || launched < seen.size) && canSelect) {
          if (!running.size) await batchWindow(work, channel);
          batch = await batchEdit(
            work,
            channel,
            data => selectBatch(work, data, channel, started),
            driver.beforePublish,
            channel,
          );
        }
        if (
          !canSelect &&
          observed.landingEntries?.some(entry => entry.status === 'queued' && !entry.waitingFor)
        )
          await batchEdit(
            work,
            channel,
            data => {
              const train = recordLandingWaits(work.store, data, channel);
              for (const entry of train.pending)
                if (entry.waitingFor?.rule !== 'overlap')
                  entry.waitingFor = {
                    ...entry.waitingFor!,
                    rule: 'capacity',
                    reason: 'Waiting for active batches to free check capacity.',
                  };
            },
            driver.beforePublish,
            channel,
          );
        if (batch) {
          observeWorkProgress();
          launched++;
          started.add(batch.id);
          const parent = batch.parentId ? running.get(batch.parentId) : undefined,
            id = batch.id;
          const compose =
            batch.status === 'composing'
              ? composeBatch(work, batch, driver.beforePublish)
              : Promise.resolve(batch);
          // Compose serially (a child needs its parent's prefixes), then check concurrently.
          const selected = batch;
          const composed = await compose.catch(
            (error: unknown) => ((failure ??= { error, batch: selected }), undefined),
          );
          observeWorkProgress();
          if (!composed) {
            halted = true;
            continue;
          }
          await completeAlreadyOnMain(work, channel);
          running.set(
            id,
            (async () => {
              for (;;) {
                const step = await advanceLandingBatch(work, id, driver, { waitMs, parent, beforeAccept });
                if (step === 'settled') onSettled?.();
                if (step !== 'advanced') return step === 'settled';
              }
            })()
              .then(
                progressed => {
                  if (!progressed) halted = true;
                  return progressed;
                },
                (error: unknown) => {
                  failure ??= { error, batch: selected };
                  halted = true;
                  return false;
                },
              )
              .finally(() => {
                // A finished parent stays gated through the recorded-main comparison.
                running.delete(id);
              }),
          );
          continue;
        }
        if (!running.size) break;
        await Promise.race(landingWorkerSignal() ? [...running.values()] : [...running.values(), sleep(200)]);
      }
      if (failure) {
        onFailure?.(work.store.select('landingBatches', failure.batch.id) ?? failure.batch);
        throw failure.error;
      }
    },
    {
      ...(waitMs === undefined ? {} : { waitMs }),
      phase: 'checking landing batch',
      anchor: work.store.directory,
    },
  );
}
