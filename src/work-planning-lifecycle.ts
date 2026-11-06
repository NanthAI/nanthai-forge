// SPDX-License-Identifier: Apache-2.0
import type { PlanningItem } from './work-planning-types.js';
/** Planning versions retain lifecycle words without inventing an execution source pin. */
export const planningIntentStatus = (
  status: PlanningItem['status'],
): 'completed' | 'abandoned' | 'proposed' | 'active' =>
  status === 'closed'
    ? 'completed'
    : status === 'abandoned'
      ? 'abandoned'
      : status === 'proposed'
        ? 'proposed'
        : 'active';
/** Intents an item links to. An Issue also links its planned Intent, whose id is the Issue id and which a start
 * opens without filling the legacy `intentIds` array (0b12fcfe), so an empty array is not "no link". Static: no call. */
export const plannedLinkIds = (item: Pick<PlanningItem, 'id' | 'kind' | 'intentIds'>): string[] =>
  item.kind === 'issue' ? [...new Set([item.id, ...item.intentIds])] : [...item.intentIds];
export const planningLabel = (status: PlanningItem['status']) =>
  status === 'closed'
    ? 'Done'
    : status === 'abandoned'
      ? 'Abandoned'
      : status === 'proposed'
        ? 'Proposed'
        : 'Planned';
export function planningVersionLabel(item: PlanningItem, previous?: PlanningItem) {
  return item.version === 1 ||
    (previous ? previous.status !== item.status : ['proposed', 'closed', 'abandoned'].includes(item.status))
    ? planningLabel(item.status)
    : 'Details edited';
}
export function planningBriefIntent(item: PlanningItem) {
  if (item.kind !== 'issue') return;
  return {
    id: item.id,
    outcome: item.title,
    constraints: item.body,
    notes: [],
    status: planningIntentStatus(item.status),
    createdAt: item.at,
  };
}
