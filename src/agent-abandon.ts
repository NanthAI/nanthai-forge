// SPDX-License-Identifier: Apache-2.0
import { automaticCleanup } from './work-auto-clean.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { NativeSource, nativeOwner } from './native-source.js';
import { workGit, executionGuard } from './work-git.js';
import { localActor } from './work-actor.js';
import { agentCheckpoint } from './agent-workflow-mutations.js';
import { finishChild } from './agent-finish-journal.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { WorkActor } from './work-actor.js';
import type { AgentAction } from './agent-workflow-schema.js';

type Command = Extract<AgentAction, { action: 'abandon' }> & { operationId: string };
const closed = (lane: Lane) => ['completed', 'abandoned'].includes(lane.state);
function dirty(store: WorkStore, lane: Lane) {
  const path = store.path(lane.id);
  if (!existsSync(path)) {
    invariant(
      closed(lane),
      'LANE_UNAVAILABLE',
      'Open Lane workspace is missing. Restore it before abandoning.',
    );
    return false;
  }
  invariant(
    !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
    'LANE_UNAVAILABLE',
    'Lane workspace is unsafe.',
  );
  if (!store.native) {
    executionGuard(path);
    invariant(
      workGit(path, ['rev-parse', 'HEAD']).trim() === lane.head,
      'LANE_STALE',
      'Lane branch head changed.',
    );
    return !!workGit(path, ['status', '--porcelain', '--untracked-files=all']).trim();
  }
  invariant(nativeOwner(path) === store.root, 'LANE_UNAVAILABLE', 'Lane belongs to another owner.');
  const source = new NativeSource(store.root);
  return source.tree(source.capture(path, false, lane.head)) !== source.tree(source.state(lane.head).files);
}
/** Save first is explicit; final lifecycle publication is atomic across all selected Lanes. */
export function agentAbandon(store: WorkStore, command: Command, attribution?: WorkActor) {
  invariant(!command.laneId !== !command.intentId, 'BAD_ARGUMENT', 'Send either laneId or intentId.');
  invariant(!command.expectedHead || command.laneId, 'BAD_ARGUMENT', 'expectedHead applies to a Lane.');
  const hash = digest(JSON.stringify(command)),
    actor = attribution ?? localActor('agent', command.actor, command.tool);
  // Legacy planning-only records have no Lane or execution pin. Keep their version chain.
  if (command.intentId) {
    const planning = store.locked(() => {
      const tx = store.records();
      const prior = tx.find('planningItems', command.operationId, 'operationId')?.record;
      if (prior)
        invariant(prior.request === hash, 'WORK_OPERATION_CHANGED', 'Abandon operation inputs changed.');
      if (!prior && tx.find('intents', command.intentId!)) return null;
      const current = prior ?? tx.find('planningItems', command.intentId!, 'id', true)?.record;
      invariant(current, 'NOT_FOUND', 'Intent or Initiative not found.');
      const item = prior ?? {
        ...current,
        operationId: command.operationId,
        request: hash,
        previousVersion: current.version,
        version: current.version + 1,
        status: 'abandoned' as const,
        reason: command.reason,
        at: new Date().toISOString(),
      };
      if (!prior) {
        tx.append('planningItems', item);
        const group = tx.find('initiatives' as never, item.id);
        if (group)
          tx.replace('initiatives' as never, group.position, {
            ...(group.record as object),
            ...item,
          } as never);
      }
      return {
        revision: prior ? tx.revision : store.commitRecords(tx),
        result: {
          operationId: command.operationId,
          intentId: command.intentId,
          status: 'abandoned',
          lifecycle: {
            from: prior
              ? (tx
                  .all('planningItems', item.id, 'id')
                  .find(version => version.version === item.previousVersion)?.status ?? current.status)
              : current.status,
            to: 'abandoned',
            at: item.at,
            actor,
            reason: item.reason,
            operation: { id: command.operationId, request: hash },
          },
        },
      };
    });
    if (planning) return planning;
  }
  const select = () => {
    const tx = store.records();
    const target = command.laneId
      ? tx.find('lanes', command.laneId)?.record
      : tx.find('intents', command.intentId!)?.record;
    invariant(target, 'NOT_FOUND', 'Lane or Intent not found.');
    const original = target.lifecycle?.find(entry => entry.operation?.id === command.operationId);
    if (original) {
      invariant(
        original.operation?.request === hash,
        'WORK_OPERATION_CHANGED',
        'Abandon operation inputs changed.',
      );
      return { tx, target, original, lanes: [] as Lane[] };
    }
    const children = command.intentId ? tx.all('lanes', command.intentId, 'intentId') : [target as Lane];
    invariant(
      !command.intentId || command.cascade || children.every(closed),
      'INTENT_OPEN_LANES',
      'Close the Intent’s Lanes first, or send cascade:true.',
    );
    const lanes = command.intentId ? children.filter(lane => !closed(lane)) : children;
    for (const lane of lanes) {
      invariant(
        lane.state !== 'creating' && !lane.pending && !lane.pendingSync && !lane.pendingUndo,
        'MERGE_PENDING',
        'Finish pending Lane operations before abandoning.',
      );
      const saved = tx.fieldFind(
        'lanes',
        lane.id,
        'checkpoints',
        finishChild(command.operationId, `abandon-save:${lane.id}`),
        'operation',
      ) as Lane['checkpoints'][number] | undefined;
      invariant(
        !saved || lane.head === saved.head,
        'LANE_STALE',
        'Lane advanced after the retained abandon save.',
      );
      invariant(
        !command.expectedHead ||
          lane.head === command.expectedHead ||
          (saved?.parent === command.expectedHead && saved.head === lane.head),
        'LANE_STALE',
        'Lane head changed.',
      );
    }
    return { tx, target, original, lanes };
  };
  const receipt = (entry: NonNullable<Lane['lifecycle']>[number]) => ({
    operationId: command.operationId,
    ...(command.laneId
      ? { laneId: command.laneId, state: 'abandoned' }
      : { intentId: command.intentId, status: 'abandoned' }),
    lifecycle: entry,
  });
  const prepared = store.locked(() => {
    const selected = select();
    if (!selected.original)
      for (const lane of selected.lanes)
        invariant(
          command.saveFirst || !dirty(store, lane),
          'LANE_DIRTY',
          'Lane has unsaved edits. Send saveFirst:true to save before abandoning.',
        );
    return selected;
  });
  const cleaned = (response: { revision: number; result: ReturnType<typeof receipt> }) => {
    const cleanup = automaticCleanup(store, `abandon:${command.operationId}`, actor.name, {
      laneIds: command.laneId
        ? [command.laneId]
        : store
            .records()
            .all('lanes', command.intentId!, 'intentId')
            .map(lane => lane.id),
    });
    return { revision: store.revision(), result: { ...response.result, ...(cleanup ? { cleanup } : {}) } };
  };
  if (prepared.original)
    return cleaned({ revision: prepared.tx.revision, result: receipt(prepared.original) });
  const heads = new Map(prepared.lanes.map(lane => [lane.id, lane.head]));
  const selection = prepared.lanes
    .map(lane => {
      const saved = prepared.tx.fieldFind(
        'lanes',
        lane.id,
        'checkpoints',
        finishChild(command.operationId, `abandon-save:${lane.id}`),
        'operation',
      ) as Lane['checkpoints'][number] | undefined;
      return { laneId: lane.id, head: saved?.parent ?? lane.head, state: lane.state };
    })
    .sort((a, b) => a.laneId.localeCompare(b.laneId));
  if (command.saveFirst)
    for (const lane of prepared.lanes) {
      const operationId = finishChild(command.operationId, `abandon-save:${lane.id}`);
      const saved = store
        .readRecords()
        ?.fieldFind('lanes', lane.id, 'checkpoints', operationId, 'operation') as
        | Lane['checkpoints'][number]
        | undefined;
      if (!saved && !dirty(store, lane)) continue;
      if (!store.native && !saved) workGit(store.path(lane.id), ['add', '--all']);
      const savedReceipt = agentCheckpoint(
        store,
        {
          action: 'checkpoint',
          laneId: lane.id,
          operationId,
          expectedHead: saved?.parent ?? lane.head,
          message: `Before abandon: ${command.reason}`.slice(0, 500),
        },
        { command, laneId: lane.id, selection },
        { actor, preserveMerge: true },
      );
      heads.set(lane.id, savedReceipt.result.head);
    }
  const response = store.locked(() => {
    const { tx, target, original, lanes } = select();
    if (original) return { revision: tx.revision, result: receipt(original) };
    invariant(
      lanes.length === heads.size &&
        lanes.every(
          lane =>
            heads.get(lane.id) === lane.head &&
            prepared.lanes.find(item => item.id === lane.id)?.state === lane.state,
        ),
      'LANE_STALE',
      'Selected Lanes changed during abandon; their work remains open.',
    );
    invariant(
      !command.intentId ||
        ('status' in target && 'status' in prepared.target && target.status === prepared.target.status),
      'WORK_STALE',
      'Intent changed during abandon.',
    );
    // Re-read bytes after saving: edits made meanwhile must remain open and visible.
    for (const lane of lanes)
      invariant(!dirty(store, lane), 'LANE_DIRTY', 'New unsaved edits remain; save them before abandoning.');
    const at = new Date().toISOString(),
      operation = { id: command.operationId, request: hash };
    const event = (from: string) => ({ from, to: 'abandoned', at, actor, reason: command.reason, operation });
    tx.setSchema(13);
    for (const lane of lanes) {
      tx.appendField('lanes', lane.id, 'lifecycle', event(lane.state));
      tx.patchFields('lanes', lane.id, { state: 'abandoned' });
    }
    const entry = event(
      command.laneId ? (target as Lane).state : 'status' in target ? target.status : 'active',
    );
    if (command.intentId) {
      tx.appendField('intents', command.intentId, 'lifecycle', entry);
      tx.patchFields('intents', command.intentId, { status: 'abandoned' });
    }
    return { revision: store.commitRecords(tx), result: receipt(entry) };
  });
  return cleaned(response);
}
