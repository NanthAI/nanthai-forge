// SPDX-License-Identifier: Apache-2.0
import { ensureLaneDirectory } from './agent-lane-directory.js';
import { withMetricRequester } from './self-metrics-journal.js';
import { automaticCleanup } from './work-auto-clean.js';
import type { OwnerLifecycle } from './owner-lifecycle-schema.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { agentAbandon } from './agent-abandon.js';
import type { WorkStore } from './work-store.js';
/** Retry the same lifecycle event before examining current state, even after a later reopen. */
export function applyOwnerLifecycle(
  store: WorkStore,
  command: OwnerLifecycle,
  operationId: string,
  actor: { kind: 'person' | 'agent'; name: string },
) {
  return withMetricRequester({ action: command.action, operationId }, actor, () =>
    applyRequestedOwnerLifecycle(store, command, operationId, actor),
  );
}
function applyRequestedOwnerLifecycle(
  store: WorkStore,
  command: OwnerLifecycle,
  operationId: string,
  actor: { kind: 'person' | 'agent'; name: string },
) {
  const request = digest(JSON.stringify(command));
  const select = () => {
    const target = store.select(command.collection, command.id);
    invariant(target, 'NOT_FOUND', 'Lane or Intent not found.');
    return target;
  };
  if (command.action === 'abandon') {
    const target = select();
    const original = target.lifecycle?.find(entry => entry.operation?.id === operationId);
    if (!original) {
      invariant(
        ('head' in target ? target.head : target.base) === command.expectedHead &&
          ('state' in target ? target.state : target.status) === command.expectedState,
        'LIFECYCLE_STALE',
        'Lane or Intent changed. Refresh before requesting this action.',
      );
    }
    return agentAbandon(
      store,
      {
        action: 'abandon',
        operationId,
        ...(command.collection === 'lanes'
          ? { laneId: command.id, expectedHead: command.expectedHead }
          : { intentId: command.id }),
        reason: command.reason,
        saveFirst: command.saveFirst,
        cascade: command.cascade,
        actor: actor.name,
      },
      actor,
    ).result;
  }
  const execute = () =>
    store.locked(
      () => {
        const tx = store.records(),
          found = tx.fields(command.collection, command.id);
        invariant(found, 'NOT_FOUND', 'Lane or Intent not found.');
        // Read only this target's lifecycle history; it carries the durable operation receipt.
        const target = select();
        const old = target.lifecycle?.find(entry => entry.operation?.id === operationId);
        if (old) {
          invariant(
            old.operation?.request === request,
            'WORK_OPERATION_CHANGED',
            'Replay the original lifecycle request.',
          );
          return { operationId, targetId: command.id, lifecycle: old };
        }
        const from = 'state' in target ? target.state : target.status;
        invariant(
          ('head' in target ? target.head : target.base) === command.expectedHead &&
            from === command.expectedState,
          'LIFECYCLE_STALE',
          'Lane or Intent changed. Refresh before requesting this action.',
        );
        invariant(from !== 'creating', 'MERGE_PENDING', 'Finish creating the Lane first.');
        const to = command.action === 'complete' ? 'completed' : 'active';
        const event = {
          from,
          to,
          at: new Date().toISOString(),
          actor,
          ...(command.reason.trim() ? { reason: command.reason.trim() } : {}),
          operation: { id: operationId, request },
        };
        tx.setSchema(13);
        tx.appendField(command.collection, command.id, 'lifecycle', event);
        tx.patchFields(
          command.collection,
          command.id,
          command.collection === 'lanes' ? { state: to } : { status: to },
        );
        store.commitRecords(tx);
        return { operationId, targetId: command.id, lifecycle: event };
      },
      { operation: 'owner lifecycle' },
    );
  const result =
    command.collection === 'lanes'
      ? store.laneLocked(command.id, execute, { operation: 'owner lifecycle' })
      : execute();
  if (
    command.action === 'reopen' &&
    command.collection === 'lanes' &&
    store.select('lanes', command.id)?.state === 'active'
  )
    ensureLaneDirectory(store, command.id);
  const cleanup =
    command.action === 'complete' && command.collection === 'lanes'
      ? automaticCleanup(store, `owner-complete:${operationId}`, actor.name, { laneIds: [command.id] })
      : undefined;
  return { ...result, ...(cleanup ? { cleanup } : {}) };
}
