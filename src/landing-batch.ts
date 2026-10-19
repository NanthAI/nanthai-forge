// SPDX-License-Identifier: Apache-2.0
import { withQueueSlot } from './landing-queue.js';
import { waitForAgentRun } from './agent-run-observer.js';
import { finishChild } from './agent-finish-journal.js';
import { ForgeError } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import {
  acceptedHead,
  batchDirectory,
  batchEdit,
  composeBatch,
  landingShape,
  selectBatch,
} from './landing-batch-store.js';
import type { WorkService } from './work.js';
import type { CheckRun, ChannelMove } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';

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
async function checkPrefix(work: WorkService, batch: LandingBatch, prefix: BatchPrefix, waitMs?: number) {
  const first = work.store.select('landingEntries', batch.entryIds[0]!)!;
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
    ),
  );
  await waitForAgentRun(work.store, prefix.runId, waitMs);
  return work.store.select('runs', prefix.runId)!.status;
}
/** `parent` settles the batch this one is stacked on: resolves true once it finished (landed or not),
 * false if it stopped early (still checking). A stacked verdict means nothing until the parent's
 * content is what main now holds, so neither acceptance nor failure attribution precedes it. */
async function settle(
  work: WorkService,
  batch: LandingBatch,
  waitMs?: number,
  parent?: Promise<boolean>,
): Promise<boolean> {
  if (batch.status === 'composing') batch = await composeBatch(work, batch);
  const cancelled = () =>
    batch.prefixes.findIndex(
      prefix => work.store.select('landingEntries', prefix.entryIds.at(-1)!)?.status === 'cancelled',
    );
  const stop = cancelled();
  const prefixes = stop < 0 ? batch.prefixes : batch.prefixes.slice(0, stop);
  const outcome = await passingPrefix(
    prefixes,
    () => batch.mode,
    async prefix => {
      const status = await checkPrefix(work, batch, prefix, waitMs);
      if (work.store.select('runs', prefix.runId)?.backend?.actual === 'local' && batch.mode === 'parallel') {
        batch.mode = 'halving';
        await batchEdit(work, batch.id, data => {
          data.landingBatches!.find(item => item.id === batch.id)!.mode = 'halving';
        });
      }
      return status;
    },
  );
  // An entry may be cancelled while its original full run is in flight.
  if (cancelled() !== stop) return settle(work, batch, waitMs, parent);
  if (batch.parentId && !outcome.stopped) {
    if (parent && !(await parent)) return false;
    const data = work.store.load();
    if (acceptedHead(data, batch.channel) !== batch.previous) {
      // The parent landed a different prefix (or nothing): this speculative check covers
      // content main does not have. Requeue its entries in their original order.
      await batchEdit(work, batch.id, data => {
        data.landingBatches!.find(item => item.id === batch.id)!.status = 'superseded';
        for (const entry of data.landingEntries!.filter(
          entry => entry.batchId === batch.id && entry.status === 'checking',
        ))
          entry.status = 'queued';
      });
      return true;
    }
  }
  if (outcome.stopped && ['queued', 'preparing', 'running'].includes(outcome.stopped)) return false;
  let move: ChannelMove | undefined;
  if (outcome.passing) {
    const prefix = outcome.passing,
      first = work.store.select('landingEntries', batch.entryIds[0]!)!;
    // Acceptance has its own short queue/CAS; no landing lock is held during checks.
    try {
      move = (
        await retryWorkPhase(batch.id, () =>
          work.dispatch(
            {
              action: 'accept-channel',
              operationId: finishChild(batch.id, `accept:${prefix.viewId}`),
              channel: batch.channel,
              viewId: prefix.viewId,
              expectedHead: prefix.head,
              expectedPrevious: batch.previous,
            },
            work.store.revision(),
            { keepOpen: first.keepOpen },
          ),
        )
      ).result as ChannelMove;
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      if (error.code === 'LANDING_CANCELLED') return settle(work, batch, waitMs, parent);
      if (['CHANNEL_CHANGED', 'CHANNEL_DIVERGED', 'CONTRACT_RESYNC_REQUIRED'].includes(error.code)) {
        await batchEdit(work, batch.id, data => {
          data.landingBatches!.find(item => item.id === batch.id)!.status = 'superseded';
          for (const entry of data.landingEntries!.filter(
            entry => entry.batchId === batch.id && entry.status === 'checking',
          ))
            entry.status = 'queued';
        });
        return false;
      }
      if (error.code !== 'REVIEW_REQUIRED') throw error;
      await batchEdit(work, batch.id, data => {
        data.landingBatches!.find(item => item.id === batch.id)!.status = 'completed';
        for (const entry of data.landingEntries!.filter(
          entry => entry.batchId === batch.id && entry.status === 'checking',
        )) {
          entry.status = 'awaiting-review';
          entry.runId = outcome.passing!.runId;
        }
      });
      return true;
    }
  }
  await batchEdit(work, batch.id, data => {
    const saved = data.landingBatches!.find(item => item.id === batch.id)!;
    saved.status = 'completed';
    if (move) saved.acceptanceId = move.id;
    const culpritId = outcome.culprit?.entryIds.at(-1);
    if (culpritId) saved.culpritId = culpritId;
    for (const entry of data.landingEntries!.filter(
      entry => entry.batchId === batch.id && entry.status === 'checking',
    )) {
      if (move && outcome.passing!.entryIds.includes(entry.id)) {
        entry.status = 'accepted';
        entry.acceptanceId = move.id;
        entry.runId = outcome.passing!.runId;
      } else if (entry.id === culpritId) {
        entry.status = 'failed';
        entry.runId = outcome.culprit!.runId;
      } else if (outcome.stopped) {
        entry.status = outcome.stopped === 'cancelled' ? 'cancelled' : 'interrupted';
        entry.runId = batch.prefixes.find(prefix =>
          data.runs.some(run => run.id === prefix.runId && run.status === outcome.stopped),
        )?.runId;
      } else entry.status = 'queued'; // Arrival time is immutable, including after failure/CAS races.
    }
  });
  return true;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Give a burst a moment to arrive before the first remote check starts. */
async function batchWindow(work: WorkService, channel: string) {
  for (;;) {
    const data = work.store.load();
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
export async function drainLandingBatches(work: WorkService, channel: string, waitMs?: number) {
  return withQueueSlot(
    batchDirectory(work, channel),
    async () => {
      const seen = new Set<string>(),
        started = new Set<string>(),
        running = new Map<string, Promise<boolean>>();
      const observe = () => {
        for (const entry of work.store.load().landingEntries ?? [])
          if (entry.channel === channel && ['queued', 'checking'].includes(entry.status)) seen.add(entry.id);
      };
      let halted = false,
        failure: { error: unknown } | undefined,
        launched = 0;
      observe();
      for (;;) {
        observe();
        let batch: LandingBatch | undefined;
        if (!halted && launched < seen.size) {
          if (!running.size) await batchWindow(work, channel);
          batch = await batchEdit(work, channel, data => selectBatch(work, data, channel, started));
        }
        if (batch) {
          launched++;
          started.add(batch.id);
          const parent = batch.parentId ? running.get(batch.parentId) : undefined,
            id = batch.id;
          const compose = batch.status === 'composing' ? composeBatch(work, batch) : Promise.resolve(batch);
          // Compose serially (a child needs its parent's prefixes), then check concurrently.
          const composed = await compose.catch((error: unknown) => ((failure ??= { error }), undefined));
          if (!composed) {
            halted = true;
            continue;
          }
          running.set(
            id,
            settle(work, composed, waitMs, parent)
              .then(
                progressed => {
                  if (!progressed) halted = true;
                  return progressed;
                },
                (error: unknown) => {
                  failure ??= { error };
                  halted = true;
                  return false;
                },
              )
              .finally(() => {
                // A finished parent stays gated through the head comparison in settle.
                running.delete(id);
              }),
          );
          continue;
        }
        if (!running.size) break;
        await Promise.race([...running.values(), sleep(200)]);
      }
      if (failure) throw failure.error;
    },
    {
      ...(waitMs === undefined ? {} : { waitMs }),
      phase: 'checking landing batch',
      anchor: work.store.directory,
    },
  );
}
