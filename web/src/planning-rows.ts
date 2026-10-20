// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../src/work-intent-progress';
import type { PlanningItem } from '../../src/work-planning-types';
import type { IntentFilter } from './intents/model';
import { age, type Tone } from './ui/status';

export type PlanningLane = {
  intentId: string;
  state?: string;
  checkpointCount?: number;
  lastCheckpointAt?: string;
  main?: { included?: boolean | null };
  checkpoints?: readonly { at: string }[];
};
type Intent = {
  id: string;
  outcome: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  memberships?: readonly { initiativeId: string }[];
};
export type PlanningRow = {
  id: string;
  title: string;
  searchText: string;
  label: ReturnType<typeof intentProgress> | 'Proposed';
  tone: Tone;
  fact: string;
  at?: string;
  intentId?: string;
  itemId?: string;
};
export type PlanningFilter = IntentFilter;
export function planningRowMatches(row: Pick<PlanningRow, 'label'>, filter: PlanningFilter) {
  if (filter === 'all') return true;
  if (filter === 'proposed') return row.label === 'Proposed';
  if (filter === 'planned') return row.label === 'Planned';
  if (filter === 'done') return row.label === 'Done' || row.label === 'Abandoned';
  return row.label === 'Working' || row.label === 'Ready';
}
function rowFacts(label: PlanningRow['label'], lanes: readonly PlanningLane[], at?: string) {
  const count = lanes.length;
  const laneFact = `${count} ${count === 1 ? 'Lane' : 'Lanes'}`;
  const landed = lanes.filter(lane => lane.main?.included).length;
  const saves = lanes.flatMap(lane => lane.checkpoints ?? []);
  const saveCount = lanes.reduce(
    (sum, lane) => sum + (lane.checkpointCount ?? lane.checkpoints?.length ?? 0),
    0,
  );
  const lastSave = [
    ...saves.map(save => save.at),
    ...lanes.flatMap(lane => (lane.lastCheckpointAt ? [lane.lastCheckpointAt] : [])),
  ]
    .sort()
    .at(-1);
  const ago = at ? age(at, Date.now(), true) : '';
  if (label === 'Proposed') return `proposed${ago ? ` ${ago}` : ''} · not yet planned`;
  if (label === 'Planned') return `Planned${ago ? ` ${ago}` : ''} · no Lane yet`;
  if (label === 'Done') return `${landed ? 'Landed on main' : 'Closed'}${count ? ` · ${laneFact}` : ''}`;
  if (label === 'Abandoned') return `Abandoned${ago ? ` ${ago}` : ''}`;
  return [
    laneFact,
    landed ? `${landed} landed` : '',
    saveCount ? `${saveCount} ${saveCount === 1 ? 'save' : 'saves'}` : '',
    lastSave ? `last save ${age(lastSave, Date.now(), true)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
function row(
  input: {
    id: string;
    title: string;
    label: PlanningRow['label'];
    intentId?: string;
    itemId?: string;
    at?: string;
  },
  lanes: readonly PlanningLane[],
): PlanningRow {
  const tone =
    input.label === 'Working'
      ? 'active'
      : input.label === 'Ready' || input.label === 'Done'
        ? 'passed'
        : input.label === 'Abandoned'
          ? 'stale'
          : 'plain';
  return { ...input, tone, searchText: input.title, fact: rowFacts(input.label, lanes, input.at) };
}

/** Each Initiative contains its linked Intents once, including legacy and unified memberships. */
export function planningGroups(
  items: readonly PlanningItem[],
  intents: readonly Intent[],
  lanes: readonly PlanningLane[],
) {
  const intentById = new Map(intents.map(intent => [intent.id, intent]));
  const grouped = new Set<string>();
  for (const item of items) {
    if (item.kind === 'initiative' || item.initiativeId)
      for (const id of item.intentIds ?? []) grouped.add(id);
  }
  for (const intent of intents) if (intent.memberships?.length) grouped.add(intent.id);
  const groups = [
    ...items
      .filter(item => item.kind === 'initiative')
      .map(item => ({ id: item.id, title: item.title, item })),
    { id: 'proposed', title: 'Proposed from outside', item: undefined },
    { id: '', title: 'No Initiative', item: undefined },
  ];
  return groups.map(group => {
    const rows = new Map<string, PlanningRow>();
    const addIntent = (id: string, linkedTitle = '') => {
      const intent = intentById.get(id);
      if (!intent || (group.id === '' && intent.status === 'proposed')) return;
      const own = lanes.filter(lane => lane.intentId === id);
      const label = intent.status === 'proposed' ? 'Proposed' : intentProgress(intent.status, own.length);
      const value = row(
        { id, intentId: id, title: intent.outcome, label, at: intent.updatedAt ?? intent.createdAt },
        own,
      );
      value.searchText = [rows.get(id)?.searchText, intent.outcome, linkedTitle].filter(Boolean).join(' ');
      rows.set(id, value);
    };
    for (const id of group.item?.intentIds ?? []) addIntent(id);
    for (const intent of intents) {
      if (
        intent.memberships?.some(membership => membership.initiativeId === group.id) ||
        (!group.item &&
          !grouped.has(intent.id) &&
          (group.id === 'proposed' ? intent.status === 'proposed' : intent.status !== 'proposed'))
      )
        addIntent(intent.id);
    }
    for (const item of items.filter(
      item => item.kind === 'issue' && (item.initiativeId ?? '') === group.id,
    )) {
      if (item.intentIds?.length) item.intentIds.forEach(id => addIntent(id, item.title));
      else
        rows.set(
          `planning:${item.id}`,
          row(
            {
              id: `planning:${item.id}`,
              itemId: item.id,
              title: item.title,
              label: intentProgress(
                item.status === 'closed' ? 'completed' : 'active',
                item.status === 'in-progress' ? 1 : 0,
              ),
              at: item.at,
            },
            [],
          ),
        );
    }
    return { ...group, rows: [...rows.values()] };
  });
}
