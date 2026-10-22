import {
  checkpointPreparationChanged,
  prepareNativeObjects,
  preparedCheckpointCurrent,
} from './native-checkpoint-publication.js';
import { stackSyncTarget } from './agent-stack.js';
import { workLockWaitMs } from './work-lock.js';
import { preparedRecordCommit } from './work-prepared-commit.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearSyncSelection,
  readSyncJournal,
  syncSelection,
  syncSelectionName,
} from './native-sync-journal.js';
import { durableReplace } from './native-durability.js';
import { syncWorkspace, syncFileKey as key, type SyncTarget as Target } from './native-sync-workspace.js';
export { syncWorkspace, syncTestHooks } from './native-sync-workspace.js';
import { NativeSource, nativeOwner, overlappingPaths, type NativeFile } from './native-source.js';
import { markNativeTextConflicts } from './native-text-merge.js';
import { DOCS_RULE, resolveDocsComposition } from './native-docs-resolve.js';
import { nativeChannels } from './native-work.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { Lane } from './work-types.js';

export type SyncCommand = {
  ontoMain?: boolean;
  operationId: string;
  laneId: string;
  expectedHead: string;
  channel: string;
};
type Conflict = NonNullable<Lane['pendingMerge']>['conflicts'][number];

const RESOLVED = 'resolved Markdown conflicts in';
const MARKERS = /^(<<<<<<< |>>>>>>> |=======\r?$)/m;
/** Checkpoints after a conflicted sync must not record unresolved marker lines. */
export function assertMergeResolved(path: string, lane: Lane) {
  invariant(
    !lane.pendingUndo,
    'UNDO_PENDING',
    'Retry the recorded undo-sync operation before checkpointing.',
  );
  const marked = (lane.pendingMerge?.conflicts ?? [])
    .filter(item => item.kind === 'text')
    .filter(item => {
      const bytes = readSource(path, item.path, Number.MAX_SAFE_INTEGER);
      return !!bytes && MARKERS.test(bytes.toString('utf8'));
    })
    .map(item => item.path);
  invariant(
    !marked.length,
    'CONFLICT_MARKERS',
    `Resolve the conflict markers before checkpointing: ${marked.join(', ')}.`,
  );
}
export function channelHead(tx: WorkRecordTransaction, channel: string): string | null {
  const data = { ...tx.data(), channelMoves: tx.all('channelMoves', channel, 'channel') };
  return nativeChannels(data).find(item => item.name === channel)?.head ?? null;
}
export function changedPaths(from: NativeFile[], to: Target[]) {
  const before = new Map(from.map(file => [file.path, key(file)])),
    after = new Map(to.map(file => [file.path, key(file)]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path))
    .sort();
}
const clean = (source: NativeSource, path: string, head: string) =>
  source.tree(source.capture(path, false, head)) === source.tree(source.state(head).files);
/** Working files for a conflicted sync: merged files, marker hunks for text, Lane version otherwise. */
export function conflictPlan(
  source: NativeSource,
  laneHead: string,
  target: string,
  channel: string,
  base?: string,
) {
  const merged = source.mergeFiles(
      laneHead,
      target,
      base ? new Set([base]) : undefined,
      base ? new Set([base]) : undefined,
      undefined,
      {
        insertionOrder: 'right-first',
      },
    ),
    files: Target[] = [...merged.files],
    conflicts: Conflict[] = [];
  const empty = Buffer.alloc(0),
    read = (file?: NativeFile) => (file ? source.object(file.blob) : empty);
  for (const item of merged.conflicts) {
    const left = read(item.left),
      right = read(item.right),
      marked = markNativeTextConflicts(read(item.base), left, right, ['lane', channel], 'right-first');
    if (!marked) {
      if (item.left) files.push(item.left);
      conflicts.push({ path: item.path, kind: 'binary' });
      continue;
    }
    const line = (bytes: Buffer) =>
      bytes.length && bytes.at(-1) !== 10 ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    const bytes = marked.conflicted
      ? marked.bytes
      : Buffer.concat([
          Buffer.from('<<<<<<< lane\n'),
          line(left),
          Buffer.from('=======\n'),
          line(right),
          Buffer.from(`>>>>>>> ${channel}\n`),
        ]);
    files.push({ path: item.path, mode: item.left?.mode ?? item.right?.mode ?? 'file', bytes });
    conflicts.push({ path: item.path, kind: 'text' });
  }
  // A file/directory clash keeps the Lane's side of that subtree.
  const lane = source.state(laneHead).files;
  let result = files;
  for (const path of overlappingPaths(files as NativeFile[])) {
    const inside = (file: { path: string }) => file.path === path || file.path.startsWith(path + '/');
    result = [...result.filter(file => !inside(file)), ...lane.filter(inside)];
    conflicts.push({ path, kind: 'binary' });
  }
  return {
    files: result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    conflicts: conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
/** Bring a Channel head into a native Lane, like `git pull`. Clean merges become a
 * two-parent Lane checkpoint; conflicts leave markers and a pending merge parent. */
export function agentSync(
  store: WorkStore,
  command: SyncCommand,
  options: { target?: string; identity?: unknown; automaticActor?: string; resolveDocs?: boolean } = {},
) {
  invariant(
    store.native,
    'UNSUPPORTED',
    'sync supports Forge-native Lanes. In a Git-backed Lane, run git merge with the Channel head, stage the result, then checkpoint.',
  );
  return store.laneLocked(
    command.laneId,
    () => {
      const tx = store.readRecords() ?? store.locked(() => store.records(), { operation: 'sync migration' }),
        version = tx.version('lanes', command.laneId),
        hash = digest(JSON.stringify(options.identity ?? command)),
        lane = tx.fields('lanes', command.laneId)?.record;
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const publish = (objects = new Map<string, Buffer>()) => {
        const end = Date.now() + (workLockWaitMs() || 1000);
        for (;;) {
          const prepared = prepareNativeObjects(source, objects);
          try {
            const revision = preparedRecordCommit(store, 'sync publication', latest => {
              latest.stageLane(tx, lane.id, version!);
              return () => {
                preparedCheckpointCurrent(source, prepared);
                return store.commitRecords(latest);
              };
            });
            clearSyncSelection(store.path(lane.id), command.operationId);
            return revision;
          } catch (error) {
            if (error !== checkpointPreparationChanged) throw error;
            if (Date.now() >= end)
              throw new ForgeError(
                'SOURCE_CHANGED',
                'Prepared sync source changed before publication. Retry the original sync operation; its target and workspace are retained.',
              );
          }
        }
      };
      const source = new NativeSource(store.root),
        path = store.path(lane.id);
      const receipt = (fields: Record<string, unknown>) => ({
        operationId: command.operationId,
        laneId: lane.id,
        channel: command.channel,
        ...fields,
        path,
      });
      const changed = (message: string) => invariant(false, 'WORK_OPERATION_CHANGED', message) as never;
      const original = tx.fieldFind('lanes', lane.id, 'checkpoints', command.operationId, 'operation') as
        Lane['checkpoints'][number] | undefined;
      if (original) {
        if (original.operation?.request !== hash)
          changed('Sync operation inputs changed. Original source remains.');
        const from = source.state(original.parent).files,
          state = source.state(original.head),
          target = original.sync?.target ?? state.parents[1] ?? original.head;
        // Only recorded resolutions need derived details. Keep the original
        // orientation so replay cannot create a reversed merge blob.
        const docsResolved = original.automatic?.summary.includes(RESOLVED),
          insertionsResolved = state.message.includes('\nboth-insertions: '),
          replay =
            docsResolved || insertionsResolved
              ? source.mergeFiles(original.parent, target, undefined, undefined, undefined, {
                  insertionOrder: 'right-first',
                })
              : undefined,
          resolved = docsResolved ? replay!.conflicts.map(item => item.path) : [],
          resolutions = insertionsResolved ? replay!.resolutions : [];
        return {
          revision: tx.revision,
          result: receipt({
            status: 'merged',
            ...(resolutions.length ? { resolutions } : {}),
            head: original.head,
            parent: original.parent,
            target,
            changedPaths: original.sync?.changedPaths ?? changedPaths(from, state.files),
            ...(resolved.length ? { docsResolution: { paths: resolved.sort(), rule: DOCS_RULE } } : {}),
            ...(original.automatic
              ? {
                  automatic: original.automatic,
                  message: original.automatic.summary,
                  undo: original.automatic.undo,
                }
              : {}),
          }),
        };
      }
      invariant(!lane.pendingUndo, 'UNDO_PENDING', 'Retry the recorded undo-sync before syncing.');
      const pending = lane.pendingMerge;
      if (pending?.operation.id === command.operationId) {
        if (pending.operation.request !== hash)
          changed('Sync operation inputs changed. Original source remains.');
        return {
          revision: tx.revision,
          result: receipt({
            status: 'conflict',
            head: lane.head,
            target: pending.parent,
            conflicts: pending.conflicts,
            ...(pending.automatic
              ? {
                  automatic: pending.automatic,
                  message: pending.automatic.summary,
                  undo: pending.automatic.undo,
                  changedPaths: pending.changedPaths,
                }
              : {}),
          }),
        };
      }
      invariant(
        !tx.positions('intents', command.operationId, 'agentOperation').length &&
          !tx.positions('lanes', command.operationId, 'agentOperation').length,
        'WORK_OPERATION_CHANGED',
        'This operation belongs to another retained action.',
      );
      invariant(
        lane.head === command.expectedHead,
        'LANE_STALE',
        'Lane head changed. Original work remains available.',
      );
      invariant(
        !pending,
        'MERGE_PENDING',
        'This Lane has an unresolved sync. Resolve its conflict markers and checkpoint first.',
      );
      invariant(
        existsSync(path) &&
          !lstatSync(path).isSymbolicLink() &&
          realpathSync(path) === path &&
          nativeOwner(path) === store.root,
        'LANE_UNAVAILABLE',
        'Lane workspace is unavailable or unsafe.',
      );
      const selectionName = syncSelectionName(command.operationId),
        journal = join(path, '.forge', selectionName),
        previous = readSyncJournal(path, selectionName, syncSelection),
        resume = previous?.head === lane.head,
        selected = stackSyncTarget(store, lane, command.ontoMain, options.target),
        stack = resume ? previous.stack : selected?.stack,
        target = resume
          ? previous.target
          : (selected?.target ?? options.target ?? channelHead(tx, command.channel));
      invariant(target, 'NOT_FOUND', `Channel ${command.channel} has no accepted head.`);
      source.state(target);
      if (resume)
        invariant(
          previous.request === hash,
          'WORK_OPERATION_CHANGED',
          'Retry the interrupted sync with its original inputs; its selected target is retained.',
        );
      if (!stack && source.contains(lane.head, target)) {
        invariant(
          clean(source, path, lane.head),
          'LANE_DIRTY',
          'The Lane has uncheckpointed edits. Checkpoint first, then sync.',
        );
        return { revision: tx.revision, result: receipt({ status: 'up-to-date', head: lane.head, target }) };
      }
      const at = resume ? previous.at : new Date().toISOString();
      if (!resume)
        durableReplace(
          journal,
          JSON.stringify({
            head: lane.head,
            channel: command.channel,
            target,
            at,
            request: hash,
            ...(stack ? { stack } : {}),
          }),
        );
      const message = `Sync ${command.channel}`,
        operation = { id: command.operationId, request: hash },
        from = source.state(lane.head).files,
        rebased = stack
          ? source.mergeFiles(
              lane.head,
              target,
              new Set([stack.before.head]),
              new Set([stack.before.head]),
              undefined,
              { insertionOrder: 'right-first' },
            )
          : undefined,
        // Retain the old child lineage: Candidate composition must recognize
        // that an explicit retarget already removed inherited parent-only files.
        composed = rebased
          ? {
              conflicts: [...rebased.conflicts.map(item => item.path), ...overlappingPaths(rebased.files)],
              ...(!rebased.conflicts.length && !overlappingPaths(rebased.files).length
                ? { head: source.writeState(rebased.files, [...new Set([target, lane.head])], message, at) }
                : {}),
            }
          : source.compose(lane.head, target, message, at, { insertionOrder: 'right-first' }),
        docs =
          !stack && !composed.head && options.resolveDocs
            ? resolveDocsComposition(source, lane.head, target, message, at)
            : null,
        merged = docs ? { ...docs, conflicts: [] } : composed;
      // Files first, metadata second: an interrupted sync leaves the old head, and
      // its retry (or any later sync) recognises the partly written workspace.
      if (merged.head) {
        const stateBytes = source.object(merged.head),
          files = source.state(merged.head).files,
          retained = new Set([...from, ...source.state(target).files].map(file => file.blob)),
          // Parent blobs are already retained by Work. Only a newly merged blob
          // and its State can be collected before publication; keep those bytes.
          objects = new Map(
            files.filter(file => !retained.has(file.blob)).map(file => [file.blob, source.object(file.blob)]),
          ),
          plan = files.map(file =>
            objects.has(file.blob) ? { ...file, bytes: objects.get(file.blob)! } : file,
          );
        syncWorkspace(source, path, lane.head, from, plan);
        const paths = changedPaths(from, files),
          automatic = options.automaticActor
            ? {
                actor: options.automaticActor,
                summary: `Updated from ${command.channel}: ${paths.length} files${docs ? `; ${RESOLVED} ${docs.paths.join(', ')} (${DOCS_RULE})` : ''}`,
                undo: `Run undo-sync with laneId ${lane.id} and syncOperationId ${command.operationId}.`,
              }
            : undefined;
        tx.setSchema(automatic ? 11 : 7);
        tx.appendField('lanes', lane.id, 'checkpoints', {
          head: merged.head,
          parent: lane.head,
          message,
          at,
          operation,
          sync: { channel: command.channel, target, changedPaths: paths, ...(stack ? { stack } : {}) },
          ...(automatic ? { automatic } : {}),
        });
        tx.patchFields('lanes', lane.id, {
          head: merged.head,
          ...(stack
            ? {
                base: target,
                stack: stack.after,
                ...(stack.after.detached &&
                lane.after &&
                'intentId' in lane.after &&
                lane.after.intentId === store.select('lanes', stack.before.laneId)?.intentId
                  ? { after: undefined }
                  : {}),
              }
            : {}),
        });
        return {
          revision: publish(new Map([...objects, [merged.head, stateBytes]])),
          result: receipt({
            status: 'merged',
            ...('resolutions' in merged ? { resolutions: merged.resolutions } : {}),
            head: merged.head,
            parent: lane.head,
            target,
            changedPaths: paths,
            ...(docs ? { docsResolution: { paths: docs.paths, rule: DOCS_RULE } } : {}),
            ...(automatic ? { automatic, message: automatic.summary, undo: automatic.undo } : {}),
          }),
        };
      }
      const plan = conflictPlan(source, lane.head, target, command.channel, stack?.before.head),
        retained = new Set([...from, ...source.state(target).files].map(file => file.blob)),
        files = plan.files.map(file =>
          file.blob && !retained.has(file.blob) ? { ...file, bytes: source.object(file.blob) } : file,
        );
      syncWorkspace(source, path, lane.head, from, files);
      const paths = changedPaths(from, plan.files),
        automatic = options.automaticActor
          ? {
              actor: options.automaticActor,
              summary: `Updated from ${command.channel}: ${paths.length} files; conflicts need resolution`,
              undo: `Run undo-sync with laneId ${lane.id} and syncOperationId ${command.operationId} to remove the pending sync.`,
            }
          : undefined;
      tx.setSchema(automatic ? 11 : 10);
      tx.patchFields('lanes', lane.id, {
        pendingMerge: {
          parent: target,
          ...(stack ? { stack } : {}),
          channel: command.channel,
          operation,
          conflicts: plan.conflicts,
          ...(automatic ? { automatic, changedPaths: paths } : {}),
        },
      });
      return {
        revision: publish(),
        result: receipt({
          status: 'conflict',
          head: lane.head,
          target,
          conflicts: plan.conflicts,
          ...(automatic
            ? { automatic, message: automatic.summary, undo: automatic.undo, changedPaths: paths }
            : {}),
        }),
      };
    },
    { operation: 'sync' },
  );
}
