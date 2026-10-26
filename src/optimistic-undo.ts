// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { finishChild } from './agent-finish-journal.js';
import { NativeSource } from './native-source.js';
import { reverseLandings } from './optimistic-bisect.js';
import { recoveryCheck, recoveryEdit } from './optimistic-recovery.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';
import type { ChannelMove, WorkView } from './work-types.js';

/** Explicit, checked compensation; retries reconcile the same acceptance. */
export async function undoOptimisticRevert(
  work: WorkService,
  command: { operationId: string; acceptanceId: string },
) {
  const store = work.store;
  invariant(store.native, 'BAD_ARGUMENT', 'Optimistic reverts belong to native owners.');
  const request = digest(JSON.stringify(command));
  const pinned = store.select('views', command.operationId);
  invariant(
    !pinned || pinned.operation?.request === request,
    'WORK_OPERATION_CHANGED',
    'Retry undo with its original acceptance and operation IDs.',
  );
  const acceptedId = finishChild(command.operationId, 'accept');
  const existing = store.select('channelMoves', acceptedId);
  if (existing) return { revision: store.revision(), result: existing };
  const data = store.load();
  const recovery = data.channelMoves.find(
    move => move.optimisticRecovery?.acceptanceId === command.acceptanceId,
  )?.optimisticRecovery;
  invariant(recovery?.status === 'reverted', 'NOT_FOUND', 'Select an automatic optimistic revert.');
  const reverted = data.channelMoves.find(move => move.id === command.acceptanceId)!;
  const audit = data.runs.find(run => run.id === recovery.auditRunId)!;
  const current = data.channelMoves
    .filter(move => move.channel === reverted.channel && move.status === 'accepted')
    .at(-1)!;
  // Pin the original selection before execution so an interrupted undo cannot change source on retry.
  let view = data.views.find(view => view.id === command.operationId);
  if (!view) {
    const head = reverseLandings(new NativeSource(store.root), current.head, [reverted], reverted.at);
    invariant(
      head,
      'RECOVERY_CONFLICT',
      'Undo conflicts with later work; original source and all changes are retained.',
    );
    view = {
      id: command.operationId,
      operation: { id: command.operationId, request },
      intentId: data.views.find(view => view.id === reverted.viewId)!.intentId,
      base: current.head,
      composedMain: current.head,
      head,
      inputs: [],
      dependencies: [],
      status: 'clean',
      at: reverted.at,
      details: `Undo automatic revert ${reverted.id}`,
      mainCheck: { channel: reverted.channel },
      recovery: { auditRunId: audit.id, phase: 'retry' },
    } satisfies WorkView;
    await retryWorkPhase(command.operationId, () =>
      recoveryEdit(
        store,
        data => {
          if (!data.views.some(item => item.id === view!.id)) data.views.push(view!);
        },
        [view!.id],
      ),
    );
  }
  const selectedView = view;
  const run = await retryWorkPhase(command.operationId, () =>
    recoveryCheck(store, { ...audit, check: store.select('checks', audit.check.id)! }, selectedView),
  );
  if (run.status !== 'passed')
    return { revision: store.revision(), result: { status: run.status, runId: run.id, viewId: view.id } };
  const selected = view;
  return retryWorkPhase(command.operationId, () =>
    work.dispatch(
      {
        action: 'accept-channel',
        operationId: acceptedId,
        channel: reverted.channel,
        viewId: selected.id,
        expectedHead: selected.head,
        expectedPrevious: selected.composedMain,
      },
      store.revision(),
      { keepOpen: true },
    ),
  ) as Promise<{ revision: number; result: ChannelMove }>;
}
