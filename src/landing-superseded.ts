// SPDX-License-Identifier: Apache-2.0
import { batchEdit } from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { LandingBatch } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';
export function supersededLandingInputs(work: WorkService, batch: LandingBatch) {
  return batch.entryIds.flatMap(id => {
    const entry = work.store.select('landingEntries', id);
    if (!entry || entry.status !== 'checking') return [];
    const view = work.store.select('views', entry.viewId);
    const newer =
      view?.inputs.flatMap(pin => {
        const current = work.store.select('lanes', pin.laneId, 'id', true);
        return current && current.head !== pin.head ? [{ laneId: pin.laneId, head: current.head }] : [];
      }) ?? [];
    return newer.length ? [{ id, newer }] : [];
  });
}
/** A new saved head ends an outstanding goal. Existing accepted receipts still
 * win; other entries requeue on their own pins and shared checks are not killed. */
export async function settleSupersededLanding(work: WorkService, batch: LandingBatch, driver: LandingDriver) {
  const changed = supersededLandingInputs(work, batch);
  if (!changed.length) return false;
  await batchEdit(
    work,
    batch.id,
    data => {
      const saved = data.landingBatches!.find(item => item.id === batch.id)!;
      saved.status = 'superseded';
      if (saved.timing) saved.timing.settledAt = new Date().toISOString();
      for (const entry of data.landingEntries!.filter(
        entry => entry.batchId === batch.id && entry.status === 'checking',
      )) {
        const replacement = changed.find(item => item.id === entry.id);
        if (!replacement) {
          entry.status = 'queued';
          continue;
        }
        entry.status = 'interrupted';
        entry.terminalAt = new Date().toISOString();
        entry.error = {
          code: 'LANDING_SUPERSEDED',
          message: `Desired head superseded by ${replacement.newer.map(pin => `Lane ${pin.laneId} head ${pin.head}`).join(', ')}.`,
        };
        entry.reason = entry.error.message;
        delete entry.waitingFor;
      }
    },
    driver.beforePublish,
    batch.channel,
  );
  return true;
}
