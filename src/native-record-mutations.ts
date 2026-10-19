// SPDX-License-Identifier: Apache-2.0
import { syncDirectory } from './native-durability.js';
import { dirname } from 'node:path';
import { localActor, type WorkActor } from './work-actor.js';
import { diskGuard } from './disk-guard.js';
import { nativeCheckpointCandidate, retainedCheckpointCandidate } from './native-checkpoint-candidate.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NativeSource, nativeOwner } from './native-source.js';
import { nativeChanges } from './native-diff.js';
import { invariant } from './errors.js';
import { assertMergeResolved } from './agent-sync.js';
import type { WorkStore } from './work-store.js';
import type { LocalWorkCommand, Lane } from './work-types.js';
import { executionBase } from './work-intent-local.js';
type NativeLaneCommand = Extract<
  LocalWorkCommand,
  { action: 'lane' | 'child-lane' | 'undo' | 'resume' | 'checkpoint' }
>;
export const scopedNativeLane = (command: LocalWorkCommand): command is NativeLaneCommand =>
  ['lane', 'child-lane', 'undo', 'resume', 'checkpoint'].includes(command.action);
export function recordNativeLane(
  store: WorkStore,
  command: LocalWorkCommand,
  revision: number,
  compact = false,
  actor: WorkActor = localActor('person'),
) {
  const run = () => recordNativeLaneLocked(store, command, revision, compact, actor);
  const laneId =
    'laneId' in command ? command.laneId : 'parentLaneId' in command ? command.parentLaneId : undefined;
  return laneId ? store.laneLocked(laneId, run, { operation: command.action }) : run();
}
function recordNativeLaneLocked(
  store: WorkStore,
  command: LocalWorkCommand,
  revision: number,
  compact: boolean,
  actor: WorkActor,
) {
  const candidate =
    command.action === 'checkpoint' ? nativeCheckpointCandidate(store, command, revision) : undefined;
  return store.locked(() => {
    let tx = store.records();
    invariant(
      Number.isSafeInteger(revision) && revision === tx.revision,
      'WORK_STALE',
      'Work changed. Refresh before retrying; nothing was overwritten.',
    );
    const source = new NativeSource(store.root),
      at = candidate?.at ?? new Date().toISOString();
    const selected = (id: string) => {
      const found = tx.fields('lanes', id);
      invariant(found, 'NOT_FOUND', 'Lane not found.');
      return found.record;
    };
    let id: string;
    let warnings: string[] = [];
    if (command.action === 'lane' || command.action === 'child-lane' || command.action === 'undo') {
      let base: string,
        intentId: string,
        name: string,
        assignment: string,
        target: string,
        parent: Lane['parent'];
      if (command.action === 'lane') {
        const intent = tx.fields('intents', command.intentId)?.record;
        invariant(intent, 'NOT_FOUND', 'Intent not found.');
        base = executionBase(intent);
        intentId = intent.id;
        name = command.name;
        assignment = command.assignment;
        target = command.target;
      } else {
        const lane = selected(command.action === 'undo' ? command.laneId : command.parentLaneId);
        invariant(lane.head === command.expectedHead, 'LANE_STALE', 'Parent Lane changed.');
        const checkpoint =
          command.action === 'undo'
            ? (tx.fieldFind('lanes', lane.id, 'checkpoints', lane.head, 'head') as
                { parent: string } | undefined)
            : undefined;
        const original = command.action === 'undo' ? checkpoint?.parent : (command.baseHead ?? lane.head);
        invariant(
          original && source.contains(lane.head, original),
          'BAD_ARGUMENT',
          'Choose a retained ancestor State.',
        );
        base = original;
        intentId = lane.intentId;
        name = command.action === 'undo' ? `Undo: ${lane.name}`.slice(0, 120) : command.name;
        assignment = lane.assignment;
        target = lane.target;
        parent = { laneId: lane.id, head: base };
      }
      warnings = diskGuard(store.root);
      source.state(base);
      id = randomUUID();
      tx.append('lanes', {
        id,
        intentId,
        name,
        assignment,
        target,
        base,
        head: base,
        state: 'creating',
        checkpoints: [],
        ...(parent ? { parent } : {}),
      });
      store.commitRecords(tx);
      warnings = source.materialize(base, store.path(id));
      tx = store.records();
      tx.patchFields('lanes', id, { state: 'active' });
    } else if (command.action === 'resume') {
      const lane = selected(command.laneId),
        path = store.path(lane.id);
      id = lane.id;
      invariant(
        lane.state === 'creating',
        'LANE_UNAVAILABLE',
        'Select an interrupted Lane to reconcile its original workspace.',
      );
      if (existsSync(path))
        invariant(
          nativeOwner(path) === store.root &&
            source.tree(source.capture(path, false, lane.head)) ===
              source.tree(source.state(lane.head).files),
          'LANE_UNAVAILABLE',
          'The interrupted Lane has partial or changed source. Existing files and its original identity are retained.',
        );
      else warnings = source.materialize(lane.head, path);
      syncDirectory(dirname(path));
      tx.patchFields('lanes', id, { state: 'active' });
    } else {
      invariant(command.action === 'checkpoint', 'BAD_ARGUMENT', 'Select a supported native Lane action.');
      const lane = selected(command.laneId);
      id = lane.id;
      invariant(lane.head === command.expectedHead, 'LANE_STALE', 'Lane State changed.');
      const retained = retainedCheckpointCandidate(source, candidate),
        capture =
          retained?.parent === lane.head
            ? retained.capture
            : source.captureReport(store.path(id), true, lane.head),
        files = capture.files;
      invariant(
        source.tree(files) === command.expectedTree,
        'LANE_STALE',
        'Working files changed after selection. Refresh before checkpointing.',
      );
      if (lane.pendingMerge) assertMergeResolved(store.path(id), lane);
      invariant(
        lane.pendingMerge || nativeChanges(source.state(lane.head).files, files),
        'NO_CHANGES',
        'Edit native Lane files before checkpointing.',
      );
      const head = source.writeState(
        files,
        lane.pendingMerge ? [lane.head, lane.pendingMerge.parent] : [lane.head],
        command.message,
        at,
      );
      tx.setSchema(12);
      tx.appendField('lanes', id, 'checkpoints', {
        actor,
        head,
        parent: lane.head,
        message: command.message,
        at,
        captureCoverage: capture.coverage,
      });
      tx.patchFields('lanes', id, { head, ...(lane.pendingMerge ? { pendingMerge: undefined } : {}) });
    }
    const result = compact
      ? {
          ...tx.fields('lanes', id)!.record,
          historyCounts: tx.fields('lanes', id)!.counts,
          detailDeferred: true,
        }
      : tx.find('lanes', id)!.record;
    return {
      revision: store.commitRecords(tx),
      result: { ...result, ...(warnings.length ? { warnings } : {}) },
    };
  });
}
