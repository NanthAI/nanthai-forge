import { preparedRecordCommit } from './work-prepared-commit.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { branchFor, commitTree, executionGuard, gitIsAncestor, headAt, workGit } from './work-git.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { SyncCommand } from './agent-sync.js';
/** Never overwrite an ignored/untracked obstruction, including a directory holding credentials. */
function obstructed(path: string, target: string) {
  const extra = [
    ...new Set(
      [
        ...workGit(path, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
        ...workGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0'),
      ].filter(Boolean),
    ),
  ];
  const tracked = workGit(path, ['ls-tree', '-r', '--name-only', '-z', target]).split('\0').filter(Boolean);
  invariant(
    !extra.some(file =>
      tracked.some(next => file === next || file.startsWith(next + '/') || next.startsWith(file + '/')),
    ),
    'SYNC_PATH_BLOCKED',
    'An untracked or ignored file blocks this update. Move it before syncing; existing bytes remain.',
  );
}
/** Git read-tree protects local modifications. A retry recognises a complete old or new index,
 * and refuses any ambiguous partial/edited workspace rather than overwriting it. */
export function gitSyncWorkspace(path: string, from: string, target: string) {
  executionGuard(path);
  const tree = workGit(path, ['write-tree']).trim(),
    old = workGit(path, ['rev-parse', `${from}^{tree}`]).trim(),
    next = workGit(path, ['rev-parse', `${target}^{tree}`]).trim();
  invariant(
    [old, next].includes(tree) && !workGit(path, ['diff-files', '--name-only', '-z']).length,
    'LANE_DIRTY',
    'Newer edits or an incomplete Git workspace update exist. Preserve and reconcile them before retrying this operation.',
  );
  obstructed(path, target);
  workGit(path, ['read-tree', '-u', '-m', from, target]);
}
export function assertGitLane(store: WorkStore, lane: Lane) {
  const path = store.path(lane.id);
  invariant(
    existsSync(path) &&
      lstatSync(path).isDirectory() &&
      !lstatSync(path).isSymbolicLink() &&
      realpathSync(path) === path,
    'LANE_UNAVAILABLE',
    'Lane workspace is unavailable or unsafe; existing source remains.',
  );
  executionGuard(path);
  const common = workGit(path, ['rev-parse', '--git-common-dir']).trim();
  invariant(
    realpathSync(resolve(path, common)) === dirname(store.directory),
    'LANE_UNAVAILABLE',
    'Lane belongs to another Git owner.',
  );
  invariant(
    workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
    'LANE_BRANCH_CHANGED',
    'Restore the Lane branch before updating it.',
  );
  return path;
}
export function agentGitSync(
  store: WorkStore,
  command: SyncCommand,
  options: { target?: string; identity?: unknown; automaticActor?: string } = {},
) {
  return store.laneLocked(
    command.laneId,
    () => {
      let tx =
        store.readRecords() ?? store.locked(() => store.records(), { operation: 'Git sync migration' });
      let version = tx.version('lanes', command.laneId);
      const publish = () => {
        const revision = preparedRecordCommit(store, 'Git sync publication', latest => {
          latest.stageLane(tx, command.laneId, version!);
          return () => store.commitRecords(latest);
        });
        tx = store.readRecords()!;
        version = tx.version('lanes', command.laneId);
        return revision;
      };
      const lane = tx.find('lanes', command.laneId)?.record;
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const path = assertGitLane(store, lane),
        hash = digest(JSON.stringify(options.identity ?? command));
      const receipt = (cp: Lane['checkpoints'][number]) => ({
        operationId: command.operationId,
        laneId: lane.id,
        channel: command.channel,
        path,
        status: cp.sync?.status ?? 'merged',
        head: cp.head,
        parent: cp.parent,
        target: cp.sync!.target,
        changedPaths: cp.sync!.changedPaths,
        ...(cp.sync?.status === 'conflict'
          ? { conflicts: cp.sync.changedPaths.map(path => ({ path, kind: 'text' })) }
          : {}),
        ...(cp.automatic
          ? { automatic: cp.automatic, message: cp.automatic.summary, undo: cp.automatic.undo }
          : {}),
      });
      const original = lane.checkpoints.find(cp => cp.operation?.id === command.operationId);
      if (original) {
        invariant(
          original.operation?.request === hash && original.sync,
          'WORK_OPERATION_CHANGED',
          'Retry the original sync inputs.',
        );
        return { revision: tx.revision, result: receipt(original) };
      }
      let pending = lane.pendingSync;
      if (pending)
        invariant(
          pending.operation?.id === command.operationId && pending.operation.request === hash,
          'WORK_OPERATION_CHANGED',
          'Retry the original pending sync.',
        );
      else {
        invariant(
          lane.head === command.expectedHead && headAt(path) === lane.head,
          'LANE_STALE',
          'Lane head changed.',
        );
        invariant(
          !lane.pendingMerge && !lane.pendingUndo && !lane.pending,
          'MERGE_PENDING',
          'Complete the pending source operation first.',
        );
        invariant(
          !workGit(path, ['status', '--porcelain']).trim(),
          'LANE_DIRTY',
          'Checkpoint/stage source edits before syncing.',
        );
        const target =
          options.target ??
          workGit(store.root, ['rev-parse', '--verify', `refs/forge/channels/${command.channel}`]).trim();
        if (gitIsAncestor(store.root, target, lane.head))
          return {
            revision: tx.revision,
            result: {
              operationId: command.operationId,
              laneId: lane.id,
              path,
              channel: command.channel,
              status: 'up-to-date',
              head: lane.head,
              target,
            },
          };
        const output = workGit(
            store.root,
            ['merge-tree', '--write-tree', '--messages', lane.head, target],
            undefined,
            true,
          ),
          [tree, ...messages] = output.trimEnd().split('\n');
        invariant(
          tree && /^[0-9a-f]{40,64}$/.test(tree),
          'COMPOSITION_FAILED',
          'Git could not compose the update; original source remains.',
        );
        const conflict = messages.some(
            line => /^\d{6} [0-9a-f]+ [123]\t/.test(line) || line.startsWith('CONFLICT '),
          ),
          workspaceHead = commitTree(store.root, tree, [lane.head, target], `Sync ${command.channel}`),
          paths = workGit(store.root, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--name-only',
            '-z',
            lane.head,
            workspaceHead,
            '--',
          ])
            .split('\0')
            .filter(Boolean),
          automatic = options.automaticActor
            ? {
                actor: options.automaticActor,
                summary: `Updated from ${command.channel}: ${paths.length} files${conflict ? '; conflicts need resolution' : ''}`,
                undo: `Run undo-sync with laneId ${lane.id} and syncOperationId ${command.operationId}.`,
              }
            : undefined;
        workGit(store.root, ['update-ref', `refs/forge/checkpoints/${workspaceHead}`, workspaceHead]);
        pending = {
          head: workspaceHead,
          parent: lane.head,
          message: `Sync ${command.channel}`,
          at: new Date().toISOString(),
          operation: { id: command.operationId, request: hash },
          sync: {
            channel: command.channel,
            target,
            changedPaths: paths,
            status: conflict ? 'conflict' : 'merged',
          },
          ...(automatic ? { automatic } : {}),
        };
        tx.setSchema(11);
        tx.patchFields('lanes', lane.id, { pendingSync: pending });
        publish();
      }
      invariant(pending?.sync, 'INVALID_WORK_STORE', 'Pending sync receipt is unavailable.');
      const actual = headAt(path);
      invariant(
        [pending.parent, pending.head].includes(actual),
        'LANE_STALE',
        'The pending sync branch changed.',
      );
      gitSyncWorkspace(path, pending.parent, pending.head);
      const conflict = pending.sync!.status === 'conflict',
        cp = conflict ? { ...pending, head: pending.parent } : pending;
      if (!conflict && actual !== pending.head)
        workGit(path, ['update-ref', branchFor(lane.id), pending.head, pending.parent]);
      tx.appendField('lanes', lane.id, 'checkpoints', cp);
      tx.patchFields('lanes', lane.id, {
        head: cp.head,
        pendingSync: undefined,
        ...(conflict
          ? {
              pendingMerge: {
                parent: pending.sync!.target,
                channel: command.channel,
                operation: pending.operation!,
                workspaceHead: pending.head,
                conflicts: pending.sync!.changedPaths.map(path => ({ path, kind: 'text' as const })),
                changedPaths: pending.sync!.changedPaths,
                ...(pending.automatic ? { automatic: pending.automatic } : {}),
              },
            }
          : {}),
      });
      return { revision: publish(), result: receipt(cp) };
    },
    { operation: 'Git sync' },
  );
}
