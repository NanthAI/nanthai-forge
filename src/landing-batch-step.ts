import { reserveBoundaryConfirmation } from './landing-confirmation.js';
import { currentChannelHead } from './agent-defaults.js';
import { validatePassingPrefix, diagnosticStatus } from './landing-diagnosis.js';
// SPDX-License-Identifier: Apache-2.0
import { finishChild } from './agent-finish-journal.js';
import { ForgeError, invariant } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import { batchEdit, composeBatch } from './landing-batch-store.js';
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
  const nextRun = next && work.store.select('runs', next.runId);
  const legacyFailure = nextRun && diagnosticStatus(nextRun) === 'failed' ? next : undefined;
  const outcome =
    batch.settlement ??
    (receipt
      ? {
          cancelledAt: cancellationBoundary(work, batch),
          ...(legacyFailure ? { failingViewId: legacyFailure.viewId } : {}),
        }
      : undefined);
  if (
    !receipt &&
    (await reserveBoundaryConfirmation(work, batch, outcome?.failingViewId ?? outcome?.culpritViewId, driver))
  )
    return 'advanced';
  const passing = batch.prefixes.find(
    prefix => prefix.viewId === (acceptedPrefix?.viewId ?? outcome?.passingViewId),
  );
  const failing = batch.prefixes.find(
    prefix => prefix.viewId === (outcome?.failingViewId ?? outcome?.culpritViewId),
  );
  const edit = <T>(update: Parameters<typeof batchEdit<T>>[2]) =>
    batchEdit(work, batch.id, update, driver.beforePublish, batch.channel);
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
    if (currentChannelHead(work.store, batch.channel) !== batch.previous) {
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
        await retryWorkPhase(batch.id, () => {
          // Validate source/evidence on a committed snapshot outside writer
          // admission. The same pointer must still be current at publication.
          const validation = work.store.observing(() => {
            if (!receipt) validatePassingPrefix(work, batch, passing);
            return { pointer: work.store.pointer(), revision: work.store.revision() };
          });
          return work.dispatch(
            {
              action: 'accept-channel',
              operationId: batchAcceptanceId(batch, passing.viewId),
              channel: batch.channel,
              viewId: passing.viewId,
              expectedHead: passing.head,
              expectedPrevious: batch.previous,
            },
            validation.revision,
            {
              keepOpen: first.keepOpen,
              beforePublish: () => {
                driver.beforePublish();
                const current = work.store.pointer();
                invariant(
                  validation.pointer && current && validation.pointer.equals(current),
                  'WORK_STALE',
                  'Landing evidence changed during preparation. Retry the original settlement.',
                );
              },
            },
          );
        })
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
    // Preserve the legacy boundary id for readers, without asserting standalone blame.
    const boundaryId = failing?.entryIds.at(-1);
    if (boundaryId) saved.culpritId = boundaryId;
    for (const entry of data.landingEntries!.filter(
      entry => entry.batchId === batch.id && entry.status === 'checking',
    )) {
      delete entry.waitingFor;
      if (move && passing!.entryIds.includes(entry.id)) {
        entry.status = 'accepted';
        entry.terminalAt = move.at;
        entry.acceptanceId = move.id;
        entry.runId = passing!.runId;
      } else if (entry.id === boundaryId) {
        entry.status = 'failed';
        entry.terminalAt = new Date().toISOString();
        entry.runId = failing!.runId;
        entry.reason = `Observed failing prefix of ${failing!.entryIds.length} landing entries on base ${batch.base}; run ${failing!.runId}. ${saved.confirmation?.verdict === 'confirmed' ? ` Confirmation run ${saved.confirmation.runId} failed again.` : ''} This does not establish a standalone or minimal failing Lane.`;
      } else if (outcome?.stopped) {
        entry.status = outcome.stopped === 'cancelled' ? 'cancelled' : 'interrupted';
        entry.terminalAt = new Date().toISOString();
        entry.runId = batch.prefixes.find(prefix =>
          data.runs.some(run => run.id === prefix.runId && diagnosticStatus(run) === outcome.stopped),
        )?.runId;
      } else entry.status = 'queued';
    }
  });
  return 'settled';
}
