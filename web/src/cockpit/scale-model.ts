// SPDX-License-Identifier: Apache-2.0
import type { PlanningItem } from '../../../src/work-planning-types';

export const SCALE_AFTER = 20;
export const SCALE_PAGE = 5;
export type InitiativeGroup = { id: string; title: string };
export type InitiativeLinks = ReadonlyMap<string, InitiativeGroup>;

/** One primary Initiative per Intent prevents double counting; all links stay in Planning. */
export function initiativeLinks(items: readonly PlanningItem[]): InitiativeLinks {
  const latest = new Map<string, PlanningItem>();
  for (const item of items)
    if (!latest.has(item.id) || latest.get(item.id)!.version < item.version) latest.set(item.id, item);
  const links = new Map<string, InitiativeGroup>();
  for (const item of [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = item.kind === 'initiative' ? item : latest.get(item.initiativeId ?? '');
    if (parent?.kind !== 'initiative') continue;
    for (const id of item.intentIds)
      if (!links.has(id) || parent.id.localeCompare(links.get(id)!.id) < 0)
        links.set(id, { id: parent.id, title: parent.title });
  }
  return links;
}

export function groupByInitiative<T>(rows: readonly T[], links: InitiativeLinks, intent: (row: T) => string) {
  const groups = new Map<string, InitiativeGroup & { rows: T[] }>();
  for (const row of rows) {
    const group = links.get(intent(row)) ?? { id: '', title: 'No Initiative' };
    if (!groups.has(group.id)) groups.set(group.id, { ...group, rows: [] });
    groups.get(group.id)!.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => Number(a.id === '') - Number(b.id === ''));
}
