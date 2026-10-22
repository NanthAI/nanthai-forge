// SPDX-License-Identifier: Apache-2.0
import { finishChild } from './agent-finish-journal.js';
import { ForgeError } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import { acceptedHead, batchEdit, composeBatch } from './landing-batch-store.js';
import { cancellationBoundary, evaluateBatch } from './landing-batch-check.js';
import type { WorkService } from './work.js';
import type { ChannelMove } from './work-types.js';
import type { LandingBatch } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

type StepOptions = {
  waitMs?: number | undefined;
  parent?: Promise<boolean> | undefined;
  beforeAccept?: (() => Promise<void>) | undefined;
};
export const batchAcceptanceId = (batch: LandingBatch, viewId: string) =>
  finishChild(batch.id, `accept:${viewId}`);
/** One resumable transition. Selection, composition, check reservations, evaluation,
 * acceptance and completion each retain their original pins. External checks and
 * waits never hold the Work lock; only publication revalidates the driver fence. */
export async function advanceLandingBatch(
  work: WorkService,
  batchId: string,
  driver: LandingDriver,
  options: StepOptions = {},
): Promise<'advanced' | 'waiting' | 'settled'> {
  const batch = work.store.select('landingBatches', batchId)!;
  if (!['composing', 'checking'].includes(batch.status)) return 'settled';
  if (batch.status === 'composing') {
    await composeBatch(work, batch, driver.beforePublish);
    return 'advanced';
  }
  // Reconcile canonical acceptance BEFORE parent/main comparisons. Main may have
  // advanced again after the original receipt and before this driver resumed.
  const acceptedPrefix = batch.prefixes.find(
    prefix =>
      work.store.select('channelMoves', batchAcceptanceId(batch, prefix.viewId))?.status === 'accepted',
  );
  const receipt =
    acceptedPrefix && work.store.select('channelMoves', batchAcceptanceId(batch, acceptedPrefix.viewId));
  if (!batch.settlement && !receipt)
    return (await evaluateBatch(work, batch, driver, options.waitMs)) ? 'advanced' : 'waiting';
  // An older driver may have accepted a shorter prefix before it could save
  // completion. Recover its exact next failing prefix from canonical run evidence.
  const next = acceptedPrefix && batch.prefixes[batch.prefixes.indexOf(acceptedPrefix) + 1];
  const legacyCulprit = next && work.store.select('runs', next.runId)?.status === 'failed' ? next : undefined;
  const outcome =
    batch.settlement ??
    (receipt
      ? {
          cancelledAt: cancellationBoundary(work, batch),
          ...(legacyCulprit ? { culpritViewId: legacyCulprit.viewId } : {}),
        }
      : undefined);
  const passing = batch.prefixes.find(
    prefix => prefix.viewId === (acceptedPrefix?.viewId ?? outcome?.passingViewId),
  );
  const culprit = batch.prefixes.find(prefix => prefix.viewId === outcome?.culpritViewId);
  const edit = <T>(update: Parameters<typeof batchEdit<T>>[2]) =>
    batchEdit(work, batch.id, update, driver.beforePublish);
  await options.beforeAccept?.();
  if (!receipt && cancellationBoundary(work, batch) !== outcome!.cancelledAt) {
    await edit(data => {
      delete data.landingBatches!.find(item => item.id === batch.id)!.settlement;
    });
    return 'advanced';
  }
  const supersede = () =>
    edit(data => {
      data.landingBatches!.find(item => item.id === batch.id)!.status = 'superseded';
      for (const entry of data.landingEntries!.filter(
        entry => entry.batchId === batch.id && entry.status === 'checking',
      ))
        entry.status = 'queued';
    });
  if (!receipt && batch.parentId && !outcome?.stopped) {
    if (options.parent && !(await options.parent)) return 'waiting';
    if (acceptedHead(work.store.load(), batch.channel) !== batch.previous) {
      await supersede();
      return 'settled';
    }
  }
  let move: ChannelMove | undefined;
  if (passing) {
    const first = work.store.select('landingEntries', batch.entryIds[0]!)!;
    try {
      // Even a known receipt replays this idempotent call to reconcile lifecycle
      // work interrupted after acceptance. No check is dispatched on this path.
      move = (
        await retryWorkPhase(batch.id, () =>
          work.dispatch(
            {
              action: 'accept-channel',
              operationId: batchAcceptanceId(batch, passing.viewId),
              channel: batch.channel,
              viewId: passing.viewId,
              expectedHead: passing.head,
              expectedPrevious: batch.previous,
            },
            work.store.revision(),
            { keepOpen: first.keepOpen, beforePublish: driver.beforePublish },
          ),
        )
      ).result as ChannelMove;
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      if (error.code === 'LANDING_CANCELLED') {
        await edit(data => {
          delete data.landingBatches!.find(item => item.id === batch.id)!.settlement;
        });
        return 'advanced';
      }
      if (['CHANNEL_CHANGED', 'CHANNEL_DIVERGED', 'CONTRACT_RESYNC_REQUIRED'].includes(error.code)) {
        await supersede();
        return 'waiting';
      }
      if (error.code !== 'REVIEW_REQUIRED') throw error;
      await edit(data => {
        data.landingBatches!.find(item => item.id === batch.id)!.status = 'completed';
        for (const entry of data.landingEntries!.filter(
          entry => entry.batchId === batch.id && entry.status === 'checking',
        )) {
          entry.status = 'awaiting-review';
          entry.runId = passing.runId;
        }
      });
      return 'settled';
    }
  }
  await edit(data => {
    const saved = data.landingBatches!.find(item => item.id === batch.id)!;
    saved.status = 'completed';
    if (move) saved.acceptanceId = move.id;
    const culpritId = culprit?.entryIds.at(-1);
    if (culpritId) saved.culpritId = culpritId;
    for (const entry of data.landingEntries!.filter(
      entry => entry.batchId === batch.id && entry.status === 'checking',
    )) {
      if (move && passing!.entryIds.includes(entry.id)) {
        entry.status = 'accepted';
        entry.acceptanceId = move.id;
        entry.runId = passing!.runId;
      } else if (entry.id === culpritId) {
        entry.status = 'failed';
        entry.runId = culprit!.runId;
      } else if (outcome?.stopped) {
        entry.status = outcome.stopped === 'cancelled' ? 'cancelled' : 'interrupted';
        entry.runId = batch.prefixes.find(prefix =>
          data.runs.some(run => run.id === prefix.runId && run.status === outcome.stopped),
        )?.runId;
      } else entry.status = 'queued';
    }
  });
  return 'settled';
}
