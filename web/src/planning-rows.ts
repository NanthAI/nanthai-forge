// SPDX-License-Identifier: Apache-2.0
import type { AttributedPlanningItem } from './planning/attribution';
import { intentProgress } from '../../src/work-intent-progress';
import type { PlanningItem } from '../../src/work-planning-types';
import type { IntentFilter } from './intents/model';
import { age, type Tone } from './ui/status';

export type PlanningLane = {
  intentId: string;
  name?: string;
  id?: string;
  startedBy?: { kind: 'person' | 'agent'; name: string };
  lifecycle?: readonly {
    from: string;
    to: string;
    at: string;
    actor?: { kind: 'person' | 'agent'; name: string };
  }[];
  state?: string;
  checkpointCount?: number;
  lastCheckpointAt?: string;
  main?: { included?: boolean | null };
  checkpoints?: readonly { at: string }[];
};
export type PlanningIntent = {
  id: string;
  outcome: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  agentStart?: { laneId: string };
  lifecycle?: PlanningLane['lifecycle'];
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
  createdAt?: string;
  actor?: { kind: 'person' | 'agent'; name: string };
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
    createdAt?: string;
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
  intents: readonly PlanningIntent[],
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
      value.actor = own.find(lane => lane.startedBy)?.startedBy;
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
              ...(item.version === 1 ? { createdAt: item.at } : {}),
            },
            [],
          ),
        );
    }
    return { ...group, rows: [...rows.values()] };
  });
}

/** Keep activity first and closed work last, preserving source order within each bucket. */
export function initiativeRows(rows: readonly PlanningRow[]) {
  const rank = (row: PlanningRow) =>
    planningRowMatches(row, 'in-motion') ? 0 : planningRowMatches(row, 'done') ? 2 : 1;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}
export function initiativeProgress(item: PlanningItem, rows: readonly PlanningRow[]) {
  const done = rows.filter(row => planningRowMatches(row, 'done')).length;
  const motion = rows.filter(row => planningRowMatches(row, 'in-motion')).length;
  return {
    total: rows.length,
    done,
    motion,
    label: item.status === 'closed' ? 'Done' : motion ? 'In motion' : 'Planned',
  } as const;
}

/** Flatten deeper retained nesting under the first visible parent without changing stored links. */
export function childInitiatives(items: readonly PlanningItem[], parentId: string) {
  const byId = new Map(items.filter(item => item.kind === 'initiative').map(item => [item.id, item]));
  return [...byId.values()].filter(item => {
    let parent = item.initiativeId;
    const seen = new Set([item.id]);
    while (parent && !seen.has(parent)) {
      if (parent === parentId) return item.id !== parentId;
      seen.add(parent);
      parent = byId.get(parent)?.initiativeId;
    }
    return false;
  });
}

export function initiativeTimeline(
  item: AttributedPlanningItem,
  rows: readonly PlanningRow[],
  intents: readonly PlanningIntent[],
  lanes: readonly PlanningLane[],
) {
  type Event = {
    id: string;
    at: string;
    label: string;
    detail: string;
    glyph: 'initiative' | 'intent' | 'lane' | 'passed' | 'stale';
    intentId?: string;
    itemId?: string;
  };
  const events: Event[] = [];
  if (item.version === 1)
    events.push({
      id: item.operationId ?? item.id,
      at: item.at,
      label: 'Created',
      detail: item.actorDisplayName ? `by ${item.actorDisplayName}` : '',
      glyph: 'initiative',
    });
  for (const row of rows) {
    const intent = intents.find(value => value.id === row.intentId);
    const at = intent?.createdAt ?? row.createdAt;
    const creator = intent?.lifecycle?.find(event => event.at === at)?.actor?.name;
    const link = { intentId: row.intentId, itemId: row.itemId };
    if (at)
      events.push({
        id: `${row.id}:planned`,
        at,
        label: row.label === 'Proposed' ? 'Intent proposed' : 'Intent planned',
        detail: [creator && `by ${creator}`, row.title].filter(Boolean).join(' · '),
        glyph: 'intent',
        ...link,
      });
    const own = lanes.filter(lane => lane.intentId === row.intentId);
    const started = intent?.agentStart && own.find(lane => lane.id === intent.agentStart?.laneId);
    const first = started && intent?.createdAt ? { at: intent.createdAt, name: started.name } : undefined;
    if (first)
      events.push({
        id: `${row.id}:motion`,
        at: first.at,
        label: 'Intent in motion',
        detail: [
          row.title,
          started && started.startedBy?.name && `by ${started.startedBy.name}`,
          first.name && `Lane ${first.name} started`,
        ]
          .filter(Boolean)
          .join(' · '),
        glyph: 'lane',
        ...link,
      });
    for (const [index, event] of (intent?.lifecycle ?? []).entries()) {
      if (!['completed', 'abandoned', 'active'].includes(event.to) || event.from === event.to) continue;
      const label =
        event.to === 'completed'
          ? 'Intent done'
          : event.to === 'abandoned'
            ? 'Intent abandoned'
            : 'Intent reopened';
      events.push({
        id: `${row.id}:lifecycle:${index}`,
        at: event.at,
        label,
        detail: [row.title, event.actor && `by ${event.actor.name}`].filter(Boolean).join(' · '),
        glyph: event.to === 'completed' ? 'passed' : event.to === 'abandoned' ? 'stale' : 'intent',
        ...link,
      });
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}
