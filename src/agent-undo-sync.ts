// SPDX-License-Identifier: Apache-2.0
import { clearSyncSelection } from './native-sync-journal.js';
import { NativeSource } from './native-source.js';
import { syncWorkspace, conflictPlan } from './agent-sync.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
export type UndoSync = { operationId: string; laneId: string; syncOperationId: string; force: boolean };
/** Undo only a recorded sync. Accepted Channel pointers and all checkpoints stay intact. */
export function agentUndoSync(store: WorkStore, command: UndoSync) {
  invariant(
    store.native,
    'UNSUPPORTED',
    'undo-sync supports native Lanes; Git merges use Git revert in the Lane.',
  );
  return store.laneLocked(
    command.laneId,
    () =>
      store.locked(
        () => {
          let tx = store.records();
          const hash = digest(JSON.stringify(command)),
            lane = tx.fields('lanes', command.laneId)?.record;
          invariant(lane, 'NOT_FOUND', 'Lane not found.');
          const source = new NativeSource(store.root),
            path = store.path(lane.id),
            original = tx.fieldFind('lanes', lane.id, 'checkpoints', command.operationId, 'operation') as
              Lane['checkpoints'][number] | undefined;
          const receipt = (head: string, forced: boolean) => ({
            operationId: command.operationId,
            laneId: lane.id,
            status: 'undone',
            head,
            syncOperationId: command.syncOperationId,
            message:
              'Returned the Lane to its pre-sync checkpoint; main and retained checkpoints are unchanged.',
            ...(forced
              ? {
                  warning:
                    'Forced undo removed newer changes from the working copy. They remain in retained checkpoints; sync again to restore main.',
                }
              : {}),
            undo: 'Sync the Lane again to bring main back, or materialize the retained newer checkpoint.',
          });
          if (original) {
            invariant(
              original.operation?.request === hash,
              'WORK_OPERATION_CHANGED',
              'Retry undo-sync with its original values.',
            );
            return { revision: tx.revision, result: receipt(original.head, command.force) };
          }
          let pending = lane.pendingUndo;
          if (pending)
            invariant(
              pending.operation.id === command.operationId && pending.operation.request === hash,
              'WORK_OPERATION_CHANGED',
              'Retry the pending undo-sync with its original values.',
            );
          else {
            const sync = tx.fieldFind(
              'lanes',
              lane.id,
              'checkpoints',
              command.syncOperationId,
              'operation',
            ) as Lane['checkpoints'][number] | undefined;
            const conflict =
              lane.pendingMerge?.operation.id === command.syncOperationId ? lane.pendingMerge : undefined;
            invariant(sync?.sync || conflict, 'NOT_FOUND', 'Select a retained sync operation.');
            invariant(!lane.pendingMerge || conflict, 'MERGE_PENDING', 'Another unresolved sync is pending.');
            invariant(
              command.force || !!conflict || lane.head === sync!.head,
              'LANE_STALE',
              'Newer checkpoints exist on top of this sync. force:true restores the old working copy; newer checkpoints remain retained.',
            );
            const files = source.capture(path, false, lane.head),
              expected = conflict
                ? conflictPlan(source, lane.head, conflict.parent, conflict.channel).files.map(file => ({
                    path: file.path,
                    blob: file.bytes ? digest(file.bytes) : file.blob!,
                    mode: file.mode,
                  }))
                : source.state(lane.head).files;
            const dirty = source.tree(files) !== source.tree(expected);
            invariant(
              command.force || !dirty,
              'LANE_DIRTY',
              'Newer uncheckpointed edits exist. Checkpoint them or use force:true; forced undo captures them before restoring the working copy.',
            );
            let from = lane.head;
            if (dirty || conflict) {
              from = source.writeState(
                source.capture(path, true, lane.head),
                [lane.head],
                'Preserve edits before forced undo-sync',
                new Date().toISOString(),
              );
              tx.appendField('lanes', lane.id, 'checkpoints', {
                head: from,
                parent: lane.head,
                message: 'Preserve edits before forced undo-sync',
                at: new Date().toISOString(),
              });
            }
            const target = conflict ? lane.head : sync!.parent;
            pending = {
              operation: { id: command.operationId, request: hash },
              from,
              target,
              syncOperationId: command.syncOperationId,
              forced: command.force,
            };
            tx.setSchema(11);
            tx.patchFields('lanes', lane.id, { head: from, pendingUndo: pending, pendingMerge: undefined });
            store.commitRecords(tx);
            tx = store.records();
          }
          // Undo retires even a selection left between sync publication and cleanup.
          clearSyncSelection(path, command.syncOperationId);
          // Durable reservation before files: retry resumes a partially restored workspace.
          syncWorkspace(
            source,
            path,
            pending.from,
            source.state(pending.from).files,
            source.state(pending.target).files,
          );
          tx.appendField('lanes', lane.id, 'checkpoints', {
            head: pending.target,
            parent: pending.from,
            message: 'Undo sync',
            at: new Date().toISOString(),
            operation: pending.operation,
            undoSync: pending.syncOperationId,
          });
          tx.patchFields('lanes', lane.id, { head: pending.target, pendingUndo: undefined });
          return { revision: store.commitRecords(tx), result: receipt(pending.target, pending.forced) };
        },
        { operation: 'undo sync publication' },
      ),
    { operation: 'undo sync' },
  );
}
