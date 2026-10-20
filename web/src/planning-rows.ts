// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../src/work-intent-progress';
import type { PlanningItem } from '../../src/work-planning-types';
import type { IntentFilter } from './intents/model';

export type PlanningRow = {
  id: string;
  title: string;
  searchText: string;
  label: ReturnType<typeof intentProgress>;
  intentId?: string;
  itemId?: string;
};
export type PlanningFilter = IntentFilter;
export function planningRowMatches(row: PlanningRow, filter: PlanningFilter) {
  return (
    filter === 'all' ||
    (filter === 'proposed'
      ? // Every stored planning item is maintainer-declared, so none is Proposed yet.
        false
      : filter === 'planned'
        ? row.label === 'Planned'
        : filter === 'done'
          ? row.label === 'Done' || row.label === 'Abandoned'
          : row.label === 'Working' || row.label === 'Ready')
  );
}

/** One row per linked Intent in a group, including links retained by legacy planning records. */
export function planningGroups(
  items: readonly PlanningItem[],
  intents: readonly { id: string; outcome: string; status: string }[],
  lanes: readonly { intentId: string }[],
) {
  const intentById = new Map(intents.map(intent => [intent.id, intent]));
  const laneCounts = new Map<string, number>();
  for (const lane of lanes) laneCounts.set(lane.intentId, (laneCounts.get(lane.intentId) ?? 0) + 1);
  const groups = [
    ...items
      .filter(item => item.kind === 'initiative')
      .map(item => ({ id: item.id, title: item.title, intentIds: item.intentIds ?? [] })),
    { id: '', title: 'No Initiative', intentIds: [] as string[] },
  ];
  return groups.map(group => {
    const rows = new Map<string, PlanningRow>();
    const addIntent = (id: string, linkedTitle = '') => {
      const intent = intentById.get(id);
      if (intent)
        rows.set(id, {
          id,
          intentId: id,
          title: intent.outcome,
          searchText: [rows.get(id)?.searchText, intent.outcome, linkedTitle].filter(Boolean).join(' '),
          label: intentProgress(intent.status, laneCounts.get(id) ?? 0),
        });
    };
    group.intentIds.forEach(id => addIntent(id));
    for (const item of items.filter(
      item => item.kind === 'issue' && (item.initiativeId ?? '') === group.id,
    )) {
      if (item.intentIds?.length) item.intentIds.forEach(id => addIntent(id, item.title));
      else
        rows.set(`planning:${item.id}`, {
          id: `planning:${item.id}`,
          itemId: item.id,
          title: item.title,
          searchText: item.title,
          label: intentProgress(
            item.status === 'closed' ? 'completed' : 'active',
            item.status === 'in-progress' ? 1 : 0,
          ),
        });
    }
    return { id: group.id, title: group.title, rows: [...rows.values()] };
  });
}
