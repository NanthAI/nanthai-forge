import { isUnifiedWork } from './work-unified-types.js';
import { citeFriction } from './friction.js';
import { workLockWaitMs } from './work-lock.js';
import { preparedRecordCommit } from './work-prepared-commit.js';
// SPDX-License-Identifier: Apache-2.0
import { applyPlanningMetadata } from './work-planning-state.js';
import { finishChild } from './agent-finish-journal.js';
import { syncDirectory } from './native-durability.js';
import { dirname } from 'node:path';
import { derivedLaneName } from './lane-name.js';
import { validateAfter } from './agent-dependencies.js';
import { localAgentSetup } from './agent-setup.js';
import { localActor, type WorkActor } from './work-actor.js';
import { diskGuard } from './disk-guard.js';
import {
  prepareCheckpoint,
  preparedCheckpointCurrent,
  checkpointPreparationChanged,
  checkpointMetadataChanged,
  nativeCheckpointSelection,
} from './native-checkpoint-publication.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkStore } from './work-store.js';
import { NativeSource, nativeOwner, type NativeCaptureCoverage } from './native-source.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { applyIntentMetadata } from './work-metadata.js';
import { branchFor, commitTree, executionGuard, headAt, materializeLane, workGit } from './work-git.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { CheckpointAction, StartAction } from './agent-workflow-schema.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { Lane, WorkData } from './work-types.js';
import { laneReceipt } from './agent-receipts.js';
import { assertMergeResolved, resolvedSyncCheckpoint } from './agent-sync.js';
const request = (command: unknown) => digest(JSON.stringify(command));
function materialize(store: WorkStore, lane: Lane) {
  const path = store.path(lane.id);
  if (!store.native) {
    materializeLane(store.root, path, lane);
    return;
  }
  const source = new NativeSource(store.root);
  if (!existsSync(path)) source.materialize(lane.base, path);
  else
    invariant(
      nativeOwner(path) === store.root &&
        source.tree(source.capture(path, false, lane.base)) === source.tree(source.state(lane.base).files),
      'LANE_DIVERGED',
      'Interrupted Lane source changed. Existing source and operation are retained.',
    );
  syncDirectory(dirname(path));
}
function sameOperation(tx: WorkRecordTransaction, operationId: string) {
  return (
    tx.positions('intents', operationId, 'agentOperation').length > 0 ||
    tx.positions('lanes', operationId, 'agentOperation').length > 0
  );
}
export function agentStart(store: WorkStore, command: StartAction, liveMcp = false) {
  return store.laneLocked(
    command.operationId,
    () => {
      const reserved = preparedRecordCommit(store, 'start reservation', tx => {
        if (!store.native) executionGuard(store.root);
        const data = tx.data(),
          hash = request(command),
          originalLane = tx.find('lanes', command.operationId, 'agentOperation')?.record,
          originalPosition = tx.positions('intents', command.operationId, 'agentOperation')[0];
        const original =
          originalPosition === undefined
            ? originalLane
              ? tx.fields('intents', originalLane.intentId)?.record
              : undefined
            : tx.fieldsAt('intents', originalPosition).record;
        let intent = original,
          lane: Lane;
        if (original) {
          invariant(
            (originalLane?.agentStart ?? original.agentStart)?.request === hash,
            'WORK_OPERATION_CHANGED',
            'This start operation has different inputs. Its original Intent and Lane are retained.',
          );
          const retained = originalLane ?? tx.fields('lanes', original.agentStart!.laneId)?.record;
          invariant(
            !retained || retained.intentId === original.id,
            'INVALID_WORK_STORE',
            'Original start Lane differs.',
          );
          invariant(retained, 'INVALID_WORK_STORE', 'Original start Lane is unavailable.');
          lane = retained;
        } else {
          invariant(
            !sameOperation(tx, command.operationId),
            'WORK_OPERATION_CHANGED',
            'This operation belongs to another retained action.',
          );
          data.channelMoves =
            command.channel === null ? [] : tx.all('channelMoves', command.channel ?? 'main', 'channel');
          const channels = store.native ? nativeChannels(data) : channelStatus(store, data);
          const channel =
            command.channel === null
              ? undefined
              : channels.find(item => item.name === (command.channel ?? 'main'));
          invariant(
            command.channel === null ||
              (!channel && command.channel === undefined) ||
              (channel?.head && channel.moveId && !channel.diagnostic),
            'CHANNEL_CHANGED',
            'Selected Channel has no intact acceptance receipt. Reconcile that Channel, or explicitly select channel:null to start from the workspace source.',
          );
          const parent = command.stackOn ? tx.fields('lanes', command.stackOn)?.record : undefined;
          invariant(!command.stackOn || parent, 'NOT_FOUND', 'Stack parent Lane not found.');
          invariant(!parent || store.native, 'UNSUPPORTED', 'Stacked Lanes use native source.');
          const base =
            parent?.head ??
            (channel?.head && channel.moveId && !channel.diagnostic
              ? channel.head
              : store.native
                ? data.nativeHead!
                : headAt(store.root));

          const at = new Date().toISOString(),
            laneId = randomUUID();
          const alias = command.intentId
            ? (tx.find('intentAliases' as never, command.intentId, 'aliasId')?.record as unknown as
                { intentId: string } | undefined)
            : undefined;
          const selectedId = alias?.intentId ?? command.intentId;
          let existing = selectedId ? tx.fields('intents', selectedId)?.record : undefined;
          const planning =
            !existing && selectedId ? tx.find('planningItems', selectedId, 'id', true)?.record : undefined;
          if (planning?.kind === 'issue') {
            existing = applyIntentMetadata(
              data,
              { action: 'intent', outcome: planning.title, constraints: planning.body, base },
              { id: planning.id, at },
            );
            tx.append('intents', existing);
            data.planningItems.push(planning);
            if (planning.initiativeId) {
              const group = tx.find('planningItems', planning.initiativeId, 'id', true)?.record;
              if (group) data.planningItems.push(group);
            }
            const version = applyPlanningMetadata(
              data,
              {
                action: 'put-planning-item',
                operationId: finishChild(command.operationId, 'planning-start'),
                itemId: planning.id,
                expectedVersion: planning.version,
                kind: planning.kind,
                title: planning.title,
                body: planning.body,
                status: 'open',
                intentIds: [existing.id],
                ...(planning.initiativeId ? { initiativeId: planning.initiativeId } : {}),
              },
              at,
            );
            tx.append('planningItems', version as typeof planning);
          }
          invariant(!command.intentId || existing, 'NOT_FOUND', 'Intent not found.');
          invariant(
            !existing || ['active', 'ready', 'proposed'].includes(existing.status),
            'INTENT_CLOSED',
            'Add a Lane to an open Intent.',
          );
          if (command.after) validateAfter(store, command.after, existing?.id);
          const after =
            command.after ??
            (parent && parent.intentId !== existing?.id ? { intentId: parent.intentId } : undefined);
          intent =
            existing ??
            applyIntentMetadata(
              data,
              {
                action: 'intent',
                outcome: command.outcome,
                constraints: command.constraints,
                base,
                ...(base === channel?.head && channel.moveId && !channel.diagnostic
                  ? {
                      baseChannel: { name: channel.name, head: channel.head, acceptanceId: channel.moveId },
                    }
                  : {}),
              },
              { id: randomUUID(), at },
            );
          if (!existing) intent.agentStart = { id: command.operationId, request: hash, laneId };
          lane = {
            id: laneId,
            ...(existing ? { agentStart: { id: command.operationId, request: hash } } : {}),
            ...(after ? { after } : {}),
            ...(parent
              ? {
                  stack: {
                    laneId: parent.id,
                    startHead: parent.head,
                    head: parent.head,
                    channel: command.channel ?? 'main',
                  },
                }
              : {}),
            startedBy: localActor('agent', command.actor, command.tool),
            startedAt: at,
            ...(command.scope ? { scope: command.scope } : {}),
            setup: localAgentSetup(store.root, liveMcp) as { machine: string; mcpConfigured: boolean },
            intentId: intent.id,
            name: command.name ?? derivedLaneName(command.outcome),
            assignment: command.assignment,
            target: command.target,
            base,
            head: base,
            state: 'creating',
            checkpoints: [],
          };
          tx.setSchema(
            (parent ? (isUnifiedWork(data) ? 22 : 21) : existing || after ? 12 : 7) as WorkData['schema'],
          );
          if (!existing) tx.append('intents', intent);
          // A planned schema-16 Intent's first Lane captures its exact source pin.
          else if (!existing.base) tx.patchFields('intents', existing.id, { base });
          if ((existing as { status?: string } | undefined)?.status === 'proposed') {
            tx.appendField('intents', existing!.id, 'lifecycle', {
              from: 'proposed',
              to: 'active',
              at,
              actor: localActor('agent', command.actor, command.tool),
            });
            tx.patchFields('intents', existing!.id, { status: 'active' });
          }
          tx.append('lanes', lane);
          citeFriction(tx, lane.id, command.frictionIds ?? [], command.operationId);
        }
        return () => {
          if (!original) store.commitRecords(tx);
          return { lane, intent: intent! };
        };
      });
      const { lane, intent } = reserved;
      const warnings = lane.state === 'creating' ? diskGuard(store.root) : [];
      return store.laneLocked(
        lane.id,
        () => {
          if (lane.state === 'creating') materialize(store, lane);
          return preparedRecordCommit(store, 'start activation', tx => {
            const creating = lane.state === 'creating';
            if (creating) tx.patchFields('lanes', lane.id, { state: 'active' });
            const siblings = tx
              .all('lanes', intent.id, 'intentId')
              .filter(item => item.id !== lane.id)
              .map(item => laneReceipt(item, store.path(item.id)));
            return () => {
              if (creating) {
                store.commitRecords(tx);
                lane.state = 'active';
              }
              return {
                revision: tx.revision,
                result: {
                  operationId: command.operationId,
                  outcome: intent.outcome,
                  siblingLanes: siblings,
                  ...(warnings.length ? { warnings } : {}),
                  ...laneReceipt(lane, store.path(lane.id)),
                  base: lane.stack?.startHead ?? lane.base,
                  head: lane.stack?.startHead ?? lane.base,
                  currentHead: lane.head,
                  baseChannel: intent.baseChannel ?? null,
                },
              };
            };
          });
        },
        { operation: 'start materialization' },
      );
    },
    { operation: 'start' },
  );
}
function recoverCheckpoint(store: WorkStore, lane: Lane, save: () => void) {
  const pending = lane.pending;
  if (!pending) return;
  const path = store.path(lane.id);
  invariant(
    existsSync(path) && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
    'LANE_UNAVAILABLE',
    'Original pending Lane workspace is unavailable.',
  );
  executionGuard(path);
  invariant(
    workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
    'LANE_BRANCH_CHANGED',
    'Pending Lane branch changed.',
  );
  const actual = headAt(path);
  invariant(
    actual === pending.parent || actual === pending.head,
    'LANE_DIVERGED',
    'Pending checkpoint has an unexpected branch head. Original candidates are retained.',
  );
  if (actual === pending.parent)
    workGit(path, ['update-ref', branchFor(lane.id), pending.head, pending.parent]);
  lane.head = pending.head;
  lane.checkpoints.push(pending);
  delete lane.pending;
  save();
}
export function agentCheckpoint(
  store: WorkStore,
  command: CheckpointAction,
  requestIdentity: unknown = command,
  /** finish reuses the current head when nothing changed (e.g. right after sync). */
  options: { allowUnchanged?: boolean; actor?: WorkActor; preserveMerge?: boolean } = {},
) {
  return store.laneLocked(
    command.laneId,
    () => {
      let preparation = prepareCheckpoint(store, command, options.preserveMerge);
      let refresh = false;
      let retryEnd: number | undefined;
      const retry = (code: string) => {
        retryEnd ??= Date.now() + (workLockWaitMs() || 1000);
        if (Date.now() >= retryEnd)
          throw new ForgeError(
            code,
            `Checkpoint publication changed throughout lock patience. Retry original operation ${command.operationId}; existing work is preserved.`,
          );
      };
      for (;;) {
        if (refresh) {
          preparation = prepareCheckpoint(store, command, options.preserveMerge);
          refresh = false;
        }
        const candidate = preparation.candidate;
        try {
          const select = (prepared?: WorkRecordTransaction) => {
            let tx = prepared ?? store.records();
            let version = tx.version('lanes', command.laneId);
            const hash = request(requestIdentity),
              selected = store.native ? tx.fields('lanes', command.laneId) : tx.find('lanes', command.laneId),
              lane = selected?.record;
            const save = (advance = true) => {
              tx.replace('lanes', selected!.position, lane!);
              preparedRecordCommit(store, 'Git checkpoint publication', latest => {
                latest.stageLane(tx, command.laneId, version!);
                if (after && lane!.after === after) latest.patchFields('lanes', command.laneId, { after });
                return () => store.commitRecords(latest, latest.revision + (advance ? 1 : 0));
              });
              tx = store.readRecords()!;
              version = tx.version('lanes', command.laneId);
            };
            invariant(lane, 'NOT_FOUND', 'Lane not found.');
            const after = (requestIdentity as { after?: Lane['after'] }).after;
            if (after) validateAfter(store, after, lane.intentId);
            // Finish the previous journaled checkpoint before a new operation can observe
            // or replace the Lane head. Its original operation identity stays replayable.
            if (!store.native && lane.pending && lane.pending.operation?.id !== command.operationId)
              recoverCheckpoint(store, lane, save);
            const pending = lane.pending?.operation?.id === command.operationId ? lane.pending : undefined;
            const original =
              (store.native
                ? (tx.fieldFind('lanes', lane.id, 'checkpoints', command.operationId, 'operation') as
                    Lane['checkpoints'][number] | undefined)
                : lane.checkpoints.find(item => item.operation?.id === command.operationId)) ?? pending;
            if (original) {
              invariant(
                original.operation?.request === hash,
                'WORK_OPERATION_CHANGED',
                'Checkpoint operation inputs changed. Original source remains available.',
              );
              if (pending) recoverCheckpoint(store, lane, save);
              return {
                revision: tx.revision,
                result: {
                  operationId: command.operationId,
                  laneId: lane.id,
                  head: original.head,
                  parent: original.parent,
                  message: original.message,
                  path: store.path(lane.id),
                  captureCoverage: original.captureCoverage,
                },
              };
            }
            invariant(
              !sameOperation(tx, command.operationId),
              'WORK_OPERATION_CHANGED',
              'This operation belongs to another retained action.',
            );
            const path = store.path(lane.id);
            invariant(
              existsSync(path) && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
              'LANE_UNAVAILABLE',
              'Lane workspace is unavailable or unsafe.',
            );
            invariant(
              lane.head === command.expectedHead,
              'LANE_STALE',
              'Lane head changed. Original work remains available.',
            );
            invariant(
              !lane.pendingSync && !lane.pendingUndo,
              'MERGE_PENDING',
              'Retry the pending sync or undo-sync before checkpointing.',
            );
            let head: string, tree: string, captureCoverage: NativeCaptureCoverage | undefined;
            const at = candidate?.at ?? new Date().toISOString();
            if (store.native) {
              invariant(
                nativeOwner(path) === store.root,
                'LANE_UNAVAILABLE',
                'Lane belongs to another source owner.',
              );
              if (!candidate) {
                if (preparation.error instanceof ForgeError && preparation.error.code === 'SOURCE_CHANGED')
                  throw checkpointPreparationChanged;
                if (preparation.error !== undefined) throw preparation.error;
                // A legacy record migration can make preparation available only
                // after records() above. Retry it outside this critical section.
                throw checkpointPreparationChanged;
              }
              preparedCheckpointCurrent(new NativeSource(store.root), candidate);
              if (candidate.merge !== JSON.stringify(lane.pendingMerge)) throw checkpointPreparationChanged;
              captureCoverage = candidate.capture.coverage;
              tree = candidate.tree;
              invariant(
                !candidate.unchanged || options.allowUnchanged,
                'NO_CHANGES',
                'Edit Lane source before checkpointing.',
              );
              head = candidate.head;
            } else {
              executionGuard(path);
              invariant(
                workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
                'LANE_BRANCH_CHANGED',
                'Lane changed branches.',
              );
              invariant(headAt(path) === command.expectedHead, 'LANE_STALE', 'Lane branch head changed.');
              if (lane.pendingMerge && !options.preserveMerge) assertMergeResolved(path, lane);
              tree = workGit(path, ['write-tree']).trim();
              invariant(
                !command.expectedTree || tree === command.expectedTree,
                'LANE_STALE',
                'Staged files changed after review.',
              );
              // Unstaged edits still need staging; only a fully clean Lane reuses its head.
              const same = !lane.pendingMerge && tree === workGit(path, ['rev-parse', 'HEAD^{tree}']).trim(),
                unchanged =
                  same && !!options.allowUnchanged && !workGit(path, ['status', '--porcelain']).trim();
              invariant(!same || unchanged, 'NO_CHANGES', 'Stage Git Lane edits before checkpointing.');
              head = unchanged
                ? lane.head
                : commitTree(
                    path,
                    tree,
                    lane.pendingMerge && !options.preserveMerge
                      ? [lane.head, lane.pendingMerge.parent]
                      : [lane.head],
                    command.message,
                  );
              if (!unchanged) workGit(path, ['update-ref', `refs/forge/checkpoints/${head}`, head]);
            }
            const checkpoint = {
              ...(store.native && lane.pendingMerge && !options.preserveMerge
                ? resolvedSyncCheckpoint(new NativeSource(store.root), lane, candidate!.capture.files)
                : {}),
              actor: options.actor ?? localActor('agent'),
              ...(captureCoverage ? { captureCoverage } : {}),
              head,
              parent: lane.head,
              message: command.message,
              at,
              operation: { id: command.operationId, request: hash },
            };
            const updateMetadata = () => {
              tx.setSchema(12);
              if (after) {
                lane.after = after;
                tx.patchFields('lanes', lane.id, { after });
              }
            };
            const response = () => ({
              revision: tx.revision,
              result: {
                operationId: command.operationId,
                laneId: lane.id,
                head,
                parent: checkpoint.parent,
                message: command.message,
                path,
                captureCoverage,
              },
            });
            if (store.native) {
              return {
                publish: () => {
                  // These content-addressed pages are invisible until the manifest
                  // CAS. Work has no record-page collector; concurrent writers may
                  // safely prepare identical bytes under the same immutable hash.
                  updateMetadata();
                  tx.appendField('lanes', lane.id, 'checkpoints', checkpoint);
                  tx.patchFields('lanes', lane.id, {
                    head,
                    ...(lane.pendingMerge?.stack && !options.preserveMerge
                      ? {
                          base: lane.pendingMerge.parent,
                          stack: lane.pendingMerge.stack.after,
                          ...(lane.pendingMerge.stack.after.detached &&
                          lane.after &&
                          'intentId' in lane.after &&
                          lane.after.intentId ===
                            store.select('lanes', lane.pendingMerge.stack.before.laneId)?.intentId
                            ? { after: undefined }
                            : {}),
                        }
                      : {}),
                    ...(lane.pendingMerge && !options.preserveMerge ? { pendingMerge: undefined } : {}),
                  });
                  return store.locked(
                    () => {
                      preparedCheckpointCurrent(new NativeSource(store.root), candidate!);
                      try {
                        store.commitRecords(tx);
                      } catch (error) {
                        if (error instanceof ForgeError && error.code === 'WORK_STALE')
                          throw checkpointMetadataChanged;
                        throw error;
                      }
                      return response();
                    },
                    { operation: 'checkpoint publication' },
                  );
                },
              };
            }
            updateMetadata();
            lane.pending = checkpoint;
            if (!options.preserveMerge) delete lane.pendingMerge;
            save(false);
            recoverCheckpoint(store, lane, save);
            return response();
          };
          const selected = store.native
            ? nativeCheckpointSelection(store, select)
            : select(
                store.readRecords() ??
                  store.locked(() => store.records(), { operation: 'checkpoint migration' }),
              );
          if (!selected) {
            refresh = true;
            continue;
          }
          return 'publish' in selected ? selected.publish() : selected;
        } catch (error) {
          if (
            error === checkpointMetadataChanged ||
            (store.native && error instanceof ForgeError && error.code === 'SOURCE_CHANGED')
          ) {
            retry(error === checkpointMetadataChanged ? 'WORK_BUSY' : 'SOURCE_CHANGED');
            continue;
          }
          if (error !== checkpointPreparationChanged) throw error;
          retry('SOURCE_CHANGED');
          refresh = true;
        }
      }
    },
    { operation: 'checkpoint' },
  );
}
