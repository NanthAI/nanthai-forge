// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { executionGuard } from './work-git.js';
import type { WorkStore } from './work-store.js';
import type { PlanningCommand, PlanningWrite, WorkData } from './work-types.js';
import type { WorkCollection, WorkRecordTransaction } from './work-record-transaction.js';
import { isUnifiedWork } from './work-unified-types.js';
import { planningTarget, type UnifiedPlanningData } from './work-planning-unified.js';
import { applyPlanningMetadata, exportPlanning, retainedPlanning } from './work-planning-state.js';
export { currentPlanning } from './work-planning-state.js';

export function planningWork(store: WorkStore, command: PlanningCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  return store.locked(() => {
    if (!store.native) executionGuard(store.root);
    if (command.action === 'export-planning') {
      const data = store.load();
      return { revision: data.revision, result: exportPlanning(data) };
    }
    const tx = store.records(),
      data = tx.data();
    const prior = tx.find('planningItems', command.operationId, 'operationId')?.record;
    const comment = tx.find('planningComments', command.operationId)?.record;
    if (prior) data.planningItems.push(prior);
    if (comment) data.planningComments.push(comment);
    const retained = retainedPlanning(data, command);
    if (retained) return { revision: data.revision, result: retained };
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before updating planning; existing work is retained.',
    );
    if (isUnifiedWork(data)) return unifiedPlanningWork(store, tx, data, command);
    const current = tx.find('planningItems', command.itemId, 'id', true)?.record;
    if (current) data.planningItems.push(current);
    if (command.action === 'put-planning-item') {
      for (const id of command.intentIds) {
        const found = tx.fields('intents', id)?.record;
        if (found) data.intents.push(found);
      }
      if (command.initiativeId && command.initiativeId !== command.itemId) {
        const found = tx.find('planningItems', command.initiativeId, 'id', true)?.record;
        if (found) data.planningItems.push(found);
      }
    }
    const result = applyPlanningMetadata(data, command, new Date().toISOString());
    if (command.action === 'put-planning-item') tx.append('planningItems', data.planningItems.at(-1)!);
    else tx.append('planningComments', data.planningComments.at(-1)!);
    return { revision: store.commitRecords(tx), result };
  });
}

/** Schema 16: load only the addressed Intents, aliases, Initiatives and history head. */
function unifiedPlanningWork(
  store: WorkStore,
  tx: WorkRecordTransaction,
  data: WorkData,
  command: PlanningWrite,
) {
  const unified = data as unknown as UnifiedPlanningData,
    positions = new Map<object, number>(),
    loaded = new Map<object, string>();
  const keep = (record: object, position: number) => {
    positions.set(record, position);
    loaded.set(record, JSON.stringify(record));
  };
  const load = (id: string) => {
    const alias = tx.find('intentAliases' as WorkCollection, id, 'aliasId')?.record as
      | UnifiedPlanningData['intentAliases'][number]
      | undefined;
    if (alias && !unified.intentAliases.some(item => item.aliasId === id)) unified.intentAliases.push(alias);
    const intentId = alias?.intentId ?? id;
    if (unified.intents.some(item => item.id === intentId)) return;
    const found = tx.find('intents', intentId);
    if (found) {
      unified.intents.push(found.record as unknown as UnifiedPlanningData['intents'][number]);
      keep(found.record, found.position);
    }
  };
  const group = (id: string) => {
    if (unified.initiatives.some(item => item.id === id)) return;
    const found = tx.find('initiatives' as WorkCollection, id);
    if (found) {
      unified.initiatives.push(found.record as UnifiedPlanningData['initiatives'][number]);
      keep(found.record as object, found.position);
    }
  };
  load(command.itemId);
  group(command.itemId);
  const target = planningTarget(unified, command.itemId).intent;
  target?.relatedIntentIds.forEach(load);
  target?.memberships.forEach(item => group(item.initiativeId));
  if (command.action === 'put-planning-item') {
    command.intentIds.forEach(load);
    if (command.initiativeId) group(command.initiativeId);
  }
  const current = tx.find(
    'planningItems',
    planningTarget(unified, command.itemId).historyId,
    'id',
    true,
  )?.record;
  if (current) {
    data.planningItems.push(current);
    // Load previous links and group so removed placements are cleared too.
    current.intentIds.forEach(load);
    if (current.initiativeId) group(current.initiativeId);
  }
  const result = applyPlanningMetadata(data, command, new Date().toISOString());
  if (command.action === 'put-planning-item') tx.append('planningItems', data.planningItems.at(-1)!);
  else tx.append('planningComments', data.planningComments.at(-1)!);
  for (const [collection, records] of [
    ['intents', unified.intents],
    ['initiatives', unified.initiatives],
  ] as const)
    for (const record of records as object[]) {
      const position = positions.get(record);
      if (position === undefined) tx.append(collection as WorkCollection, record as never);
      else if (loaded.get(record) !== JSON.stringify(record))
        tx.replace(collection as WorkCollection, position, record as never);
    }
  return { revision: store.commitRecords(tx), result };
}
