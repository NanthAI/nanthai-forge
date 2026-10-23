// SPDX-License-Identifier: Apache-2.0
import type { ConflictNotice } from './agent-conflict-notice.js';
import type { RepairResolution, SyncLineage } from './agent-repair-types.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkView } from './work-types.js';

/** Project existing guarded sync receipts. No file capture/write, rebase, check
 * reuse or model scheduling happens while observing repair/ownership context. */
export function syncLineage(lane: Lane, head: string): SyncLineage[] {
  const descendants = new Set([head]);
  const syncs: SyncLineage[] = [];
  for (const checkpoint of lane.checkpoints) {
    if (!descendants.has(checkpoint.parent)) continue;
    descendants.add(checkpoint.head);
    if (!checkpoint.sync) continue;
    const operation = checkpoint.sync.operation ?? checkpoint.operation;
    if (!operation) continue;
    syncs.push({
      laneId: lane.id,
      operationId: operation.id,
      status: checkpoint.sync.status ?? 'merged',
      ...(checkpoint.sync.operation && checkpoint.sync.status === 'conflict'
        ? { resolvedHead: checkpoint.head }
        : {}),
      parent: checkpoint.parent,
      head: checkpoint.head,
      target: checkpoint.sync.target,
      undo: { action: 'undo-sync', laneId: lane.id, syncOperationId: operation.id, force: false },
      undoneBy: [],
    });
  }
  if (lane.pendingMerge && descendants.has(lane.head)) {
    const pending = lane.pendingMerge;
    syncs.push({
      laneId: lane.id,
      operationId: pending.operation.id,
      status: 'conflict',
      parent: lane.head,
      head: lane.head,
      target: pending.parent,
      undo: { action: 'undo-sync', laneId: lane.id, syncOperationId: pending.operation.id, force: false },
      undoneBy: [],
    });
  }
  for (const checkpoint of lane.checkpoints) {
    if (
      !checkpoint.undoSync ||
      !checkpoint.undoSyncDetails ||
      syncs.some(sync => sync.operationId === checkpoint.undoSync)
    )
      continue;
    const detail = checkpoint.undoSyncDetails;
    if (!descendants.has(detail.parent)) continue;
    syncs.push({
      laneId: lane.id,
      operationId: checkpoint.undoSync,
      ...detail,
      undo: { action: 'undo-sync', laneId: lane.id, syncOperationId: checkpoint.undoSync, force: false },
      undoneBy: [],
    });
  }
  for (const sync of syncs)
    sync.undoneBy = lane.checkpoints.flatMap(checkpoint =>
      checkpoint.undoSync === sync.operationId && checkpoint.operation
        ? [{ operationId: checkpoint.operation.id, head: checkpoint.head, preservedHead: checkpoint.parent }]
        : [],
    );
  return syncs;
}

export function decorateRepair(store: WorkStore, notice: ConflictNotice): ConflictNotice {
  const tx = store.readRecords();
  if (!tx) return notice;
  const resolutions: RepairResolution[] = [];
  let views: WorkView[] | undefined;
  for (const intent of Array.from({ length: tx.manifest.collections.intents?.count ?? 0 }, (_, index) =>
    tx.at('intents', index),
  )) {
    const repairs = intent.notes.flatMap(note =>
      note.handoff?.repairs?.includes(notice.noticeId) ? [note.handoff] : [],
    );
    const pins: { laneId: string; head: string; handoffId?: string | undefined }[] = repairs.map(handoff => ({
      laneId: handoff.laneId,
      head: handoff.head,
      handoffId: handoff.operationId,
    }));
    if (intent.id === notice.repairIntentId)
      pins.push(
        ...tx
          .all('lanes', intent.id, 'intentId')
          .filter(lane => !pins.some(pin => pin.laneId === lane.id && pin.head === lane.head))
          .map(lane => ({ laneId: lane.id, head: lane.head, handoffId: undefined })),
      );
    for (const pin of pins) {
      views ??= Array.from({ length: tx.manifest.collections.views?.count ?? 0 }, (_, index) =>
        tx.at('views', index),
      );
      const lane = tx.fields('lanes', pin.laneId)?.record;
      resolutions.push({
        noticeId: notice.noticeId,
        intentId: intent.id,
        ...pin,
        applicability: lane?.head === pin.head ? 'current' : 'historical',
        candidates: views
          .filter(view => view.inputs.some(input => input.laneId === pin.laneId && input.head === pin.head))
          .map(view => ({
            viewId: view.id,
            head: view.head,
            status: view.status,
            checks: tx
              .all('runs', view.id, 'viewId')
              .filter(
                run =>
                  run.head === view.head &&
                  run.base === view.base &&
                  JSON.stringify(run.inputs) === JSON.stringify(view.inputs) &&
                  JSON.stringify(run.dependencies) === JSON.stringify(view.dependencies ?? []),
              )
              .map(run => ({
                runId: run.id,
                head: run.head,
                definition: run.check.definition,
                status: run.status,
              })),
            acceptances: Array.from(
              { length: tx.manifest.collections.channelMoves?.count ?? 0 },
              (_, index) => tx.at('channelMoves', index),
            )
              .filter(
                move => move.status === 'accepted' && move.viewId === view.id && move.head === view.head,
              )
              .map(move => ({
                id: move.id,
                head: move.head,
                ...(move.automatic ? { undo: move.automatic.undo } : {}),
              })),
          })),
      });
    }
  }
  const syncs = notice.participants.flatMap(participant => {
    const lane = tx.find('lanes', participant.lane)?.record;
    return lane ? syncLineage(lane, participant.head) : [];
  });
  return {
    ...notice,
    applicability:
      notice.integration?.applicability ??
      (notice.evidence?.some(evidence => evidence.kind === 'check') ? notice.applicability : undefined) ??
      (notice.participants.every(p =>
        p.lane === 'main'
          ? Array.from({ length: tx.manifest.collections.channelMoves?.count ?? 0 }, (_, index) =>
              tx.at('channelMoves', index),
            )
              .filter(move => move.channel === 'main' && move.status === 'accepted')
              .at(-1)?.head === p.head
          : tx.fields('lanes', p.lane)?.record.head === p.head,
      )
        ? 'current'
        : 'historical'),
    ...(resolutions.length ? { resolutions } : {}),
    ...(syncs.length ? { syncs } : {}),
  };
}
