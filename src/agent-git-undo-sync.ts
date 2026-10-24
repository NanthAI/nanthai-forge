// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { assertGitLane, gitSyncWorkspace } from './agent-git-sync.js';
import { branchFor, commitTree, headAt, workGit } from './work-git.js';
import type { WorkStore } from './work-store.js';
import type { UndoSync } from './agent-undo-sync.js';
export function agentGitUndoSync(store: WorkStore, command: UndoSync) {
  return store.laneLocked(
    command.laneId,
    () =>
      store.locked(
        () => {
          let tx = store.records();
          const lane = tx.find('lanes', command.laneId)?.record;
          invariant(lane, 'NOT_FOUND', 'Lane not found.');
          const path = assertGitLane(store, lane),
            hash = digest(JSON.stringify(command));
          const receipt = (head: string) => ({
            operationId: command.operationId,
            laneId: lane.id,
            status: 'undone',
            head,
            syncOperationId: command.syncOperationId,
            message:
              'Returned the Lane to its pre-sync checkpoint; main and retained checkpoints are unchanged.',
            ...(command.force
              ? {
                  warning:
                    'Forced undo restored the older working copy. Newer captured edits remain in checkpoints.',
                }
              : {}),
            undo: 'Sync the Lane again to restore main, or restore a retained newer Git checkpoint.',
          });
          const original = lane.checkpoints.find(cp => cp.operation?.id === command.operationId);
          if (original) {
            invariant(
              original.operation?.request === hash,
              'WORK_OPERATION_CHANGED',
              'Retry undo-sync with its original values.',
            );
            return { revision: tx.revision, result: receipt(original.head) };
          }
          let pending = lane.pendingUndo;
          if (pending)
            invariant(
              pending.operation.id === command.operationId && pending.operation.request === hash,
              'WORK_OPERATION_CHANGED',
              'Retry the original pending undo-sync.',
            );
          else {
            const sync = lane.checkpoints.find(cp => cp.operation?.id === command.syncOperationId);
            invariant(sync?.sync, 'NOT_FOUND', 'Select a retained sync operation.');
            invariant(
              !lane.pendingSync && !lane.pending,
              'MERGE_PENDING',
              'Retry the pending source operation first.',
            );
            invariant(
              !lane.pendingMerge || lane.pendingMerge.operation.id === command.syncOperationId,
              'MERGE_PENDING',
              'Another merge is pending.',
            );
            invariant(headAt(path) === lane.head, 'LANE_STALE', 'Lane branch changed.');
            invariant(
              command.force || lane.head === sync.head,
              'LANE_STALE',
              'Newer checkpoints exist. force:true restores the old copy and keeps newer checkpoints.',
            );
            const expected = lane.pendingMerge?.workspaceHead ?? lane.head,
              staged = workGit(path, ['write-tree']).trim(),
              dirty =
                staged !== workGit(path, ['rev-parse', `${expected}^{tree}`]).trim() ||
                !!workGit(path, ['diff-files', '--name-only', '-z']).length ||
                !!workGit(path, ['ls-files', '--others', '--exclude-standard', '-z']).length;
            invariant(
              command.force || !dirty,
              'LANE_DIRTY',
              'Newer uncheckpointed edits exist; checkpoint them or use force:true to capture them before undo.',
            );
            let from = expected;
            if (dirty) {
              workGit(path, ['add', '--all', '--', '.']);
              from = commitTree(
                path,
                workGit(path, ['write-tree']).trim(),
                [lane.head],
                'Preserve edits before forced undo-sync',
              );
              workGit(path, ['update-ref', `refs/forge/checkpoints/${from}`, from]);
              tx.appendField('lanes', lane.id, 'checkpoints', {
                head: from,
                parent: lane.head,
                message: 'Preserve edits before forced undo-sync',
                at: new Date().toISOString(),
              });
            }
            pending = {
              operation: { id: command.operationId, request: hash },
              from,
              target: sync.parent,
              branchFrom: lane.head,
              syncOperationId: command.syncOperationId,
              forced: command.force,
            };
            tx.setSchema(11);
            tx.patchFields('lanes', lane.id, { pendingUndo: pending });
            store.commitRecords(tx);
            tx = store.records();
          }
          const branchFrom = pending.branchFrom ?? pending.from,
            actual = headAt(path);
          invariant(
            [branchFrom, pending.target].includes(actual),
            'LANE_STALE',
            'The pending undo branch changed.',
          );
          gitSyncWorkspace(path, pending.from, pending.target);
          if (actual !== pending.target)
            workGit(path, ['update-ref', branchFor(lane.id), pending.target, branchFrom]);
          tx.appendField('lanes', lane.id, 'checkpoints', {
            head: pending.target,
            parent: pending.from,
            message: 'Undo sync',
            at: new Date().toISOString(),
            operation: pending.operation,
            undoSync: pending.syncOperationId,
          });
          tx.patchFields('lanes', lane.id, {
            head: pending.target,
            pendingUndo: undefined,
            pendingMerge: undefined,
          });
          return { revision: store.commitRecords(tx), result: receipt(pending.target) };
        },
        { operation: 'Git undo sync publication' },
      ),
    { operation: 'Git undo sync' },
  );
}
