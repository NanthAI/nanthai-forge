// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { editWork } from './work-edit.js';
import { landingRecords, editLandingRecords } from './landing-records.js';
import { landingPositions } from './landing-records-index.js';
import { entryProgress, entryStall } from './landing-entry-stall.js';
import { LANDING_STALL_MS } from './landing-stall.js';
import type { WorkStore } from './work-store.js';
/** One deadline, only while a pending entry has not alarmed at its latest progress.
 * Runs independently of the driver, which may be awaiting a runner or lost owner. */
export function watchLandingStalls(store: WorkStore, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let invalidation: ReturnType<typeof setImmediate> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closed || signal.aborted) return;
    const data = landingStallRecords(store);
    const pending = (data.landingEntries ?? []).filter(entry =>
      ['queued', 'checking', 'awaiting-review'].includes(entry.status),
    );
    const due = pending.filter(entry => {
      const at = entryProgress(data, entry).at;
      return Number.isFinite(Date.parse(at)) && entry.stall?.lastProgressAt !== at;
    });
    if (!due.length) return;
    const deadline = Math.min(
      ...due.map(entry => Date.parse(entryProgress(data, entry).at) + LANDING_STALL_MS),
    );
    timer = setTimeout(
      async () => {
        timer = undefined;
        try {
          if (closed || signal.aborted) return;
          const channels = new Set(due.map(entry => entry.channel));
          for (const channel of channels) {
            const publish = (current: ReturnType<typeof landingRecords>) => {
              let changed = false;
              for (const entry of current.landingEntries ?? []) {
                const stall = entryStall(current, entry);
                if (!stall || entry.stall?.lastProgressAt === stall.lastProgressAt) continue;
                entry.stall = stall;
                changed = true;
              }
              return changed;
            };
            const tx = store.readRecords();
            if (tx) {
              try {
                await editLandingRecords(store, channel, publish, tx, channel);
              } finally {
                tx.dispose();
              }
            } else
              editWork(store, current => {
                if (publish(current)) current.revision++;
              });
          }
          refresh();
        } catch (error) {
          retry(error);
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
  };
  const retry = (error: unknown) => {
    if (closed || signal.aborted) return;
    console.error(
      JSON.stringify({
        event: 'landing-stall-error',
        code: error instanceof ForgeError ? error.code : 'LANDING_STALL_FAILED',
      }),
    );
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 60_000);
    timer.unref();
  };
  const refresh = () => {
    try {
      schedule();
    } catch (error) {
      retry(error);
    }
  };
  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (invalidation) clearImmediate(invalidation);
  };
  signal.addEventListener('abort', close, { once: true });
  refresh();
  return {
    refresh,
    invalidate: () => {
      if (closed || signal.aborted || invalidation) return;
      invalidation = setImmediate(() => {
        invalidation = undefined;
        refresh();
      });
      invalidation.unref();
    },
    close: () => {
      close();
      signal.removeEventListener('abort', close);
    },
  };
}

/** Deadline observations need live scalar entries and their exact batch/run
 * progress, never Lane histories, Views or unrelated completed evidence. */
export function landingStallRecords(store: WorkStore) {
  const tx = store.readRecords();
  if (!tx) return landingRecords(store);
  try {
    const data = tx.data();
    data.landingEntries = landingPositions(store, tx, 'landingEntries', [
      'queued',
      'checking',
      'awaiting-review',
    ]).map(position => tx.fieldsAt('landingEntries', position).record);
    data.landingBatches = [...new Set(data.landingEntries.flatMap(entry => entry.batchId ?? []))].flatMap(
      id => tx.find('landingBatches', id)?.record ?? [],
    );
    data.runs = [
      ...new Set(
        data.landingBatches.flatMap(batch => [
          ...batch.prefixes.map(prefix => prefix.runId),
          ...(batch.confirmation ? [batch.confirmation.runId] : []),
        ]),
      ),
    ].flatMap(id => tx.fields('runs', id)?.record ?? []);
    const moves = new Set(
      data.landingEntries.flatMap(entry =>
        entry.acceptanceId ? tx.positions('channelMoves', entry.acceptanceId) : [],
      ),
    );
    for (const batch of data.landingBatches)
      for (const prefix of batch.prefixes)
        for (const position of tx.positions('channelMoves', prefix.viewId, 'viewId')) moves.add(position);
    data.channelMoves = [...moves]
      .sort((a, b) => a - b)
      .map(position => tx.fieldsAt('channelMoves', position).record);
    return data;
  } finally {
    tx.dispose();
  }
}
