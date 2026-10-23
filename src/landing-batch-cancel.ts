// SPDX-License-Identifier: Apache-2.0
import { batchEdit } from './landing-batch-store.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';
/** Cancelling a queue-entry id retains its pins and leaves already accepted work intact. */
export async function cancelLandingEntry(work: WorkService, id: string) {
  const result = await batchEdit(work, id, data => {
    const entry = data.landingEntries!.find(entry => entry.id === id)!;
    const batch = data.landingBatches?.find(batch => batch.id === entry.batchId);
    const accepted = batch?.prefixes.find(
      prefix =>
        prefix.entryIds.includes(id) &&
        data.channelMoves.some(move => move.viewId === prefix.viewId && move.status === 'accepted'),
    );
    if (accepted || entry.status === 'accepted') return { entry };
    if (entry.status !== 'cancelled') entry.terminalAt = new Date().toISOString();
    entry.status = 'cancelled';
    const runId = batch?.prefixes.at(-1)?.runId;
    return { entry, ...(runId ? { runId } : {}) };
  });
  if (result.runId && work.store.select('runs', result.runId))
    await retryWorkPhase(id, () =>
      work.dispatch({ action: 'cancel-check', operationId: result.runId }, work.store.revision()),
    );
  return { revision: work.store.revision(), result: result.entry };
}
