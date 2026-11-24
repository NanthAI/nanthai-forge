// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import { planningStatusTransition } from '../src/work-planning-state';
import { isShelved } from '../src/work-planning-types';

export type PlanningTimes = NonNullable<Doc<'projectHostedRecordHeads'>['planningTimes']>;

type Item = { version: number; status: string; at?: string; was?: string; purged?: unknown };
type Head = { version: number; status: string; value?: string; planningTimes?: PlanningTimes };

// Journal writes use UTC ISO timestamps. Reject dates that Date.parse silently normalizes.
export function instant(at: string | undefined) {
  if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)) return NaN;
  const time = Date.parse(at);
  return Number.isFinite(time) &&
    new Date(time).toISOString() === (at.includes('.') ? at : at.replace('Z', '.000Z'))
    ? time
    : NaN;
}

export const planningTime = (at?: string) => (at && Number.isFinite(instant(at)) ? at : null);

export function pinnedPlanningTimes(head: Pick<Head, 'version' | 'planningTimes'>) {
  return head.planningTimes?.version === head.version ? head.planningTimes : undefined;
}

/** No history read on writes. Missing or out-of-order evidence leaves the head for the backfill. */
export function advancePlanningTimes(item: Item, head?: Head): PlanningTimes | undefined {
  if (item.purged) return;
  const at = planningTime(item.at);
  if (item.version === 1 && !head) {
    const closedAt = item.status === 'closed' ? at : null;
    return { version: 1, lastStatusChangeAt: at, closedAt, closeKept: closedAt };
  }
  if (!head) return;
  const previous = pinnedPlanningTimes(head);
  const changed = planningStatusTransition(item, head);
  if (!previous || changed === null || item.version <= head.version) return;
  let closeKept = previous.closeKept;
  if (item.status === 'closed' && changed) {
    if (!isShelved(head.status)) closeKept = at;
    else {
      if (head.value === undefined) return;
      const { was } = JSON.parse(head.value) as Item;
      closeKept = was === undefined ? null : was === 'closed' ? closeKept : at;
    }
  } else if (isShelved(item.status) && item.was === 'closed') {
    // A copied snapshot with an inconsistent `was` cannot prove its preserved close from the head.
    if (head.status !== 'closed' && (!isShelved(head.status) || !head.value)) return;
    if (isShelved(head.status) && (JSON.parse(head.value!) as Item).was !== 'closed') return;
  } else if (item.status !== 'closed') closeKept = null;
  return {
    version: item.version,
    lastStatusChangeAt: changed ? at : previous.lastStatusChangeAt,
    closedAt: item.status === 'closed' ? closeKept : null,
    closeKept,
  };
}
