// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { effectiveRank, isLive, rankBetween, type PlanRow } from '../../../../src/planning-model';
import {
  planningBatchLimit,
  type BatchFields,
  type BatchPut,
  type BatchWrite,
} from '../../../../src/planning-batch';
import type { PlanView } from './model';

export function parentRefusal(view: PlanView, child: PlanRow | undefined, parent: PlanRow) {
  if (parent.id === child?.id) return 'This Item';
  if (parent.kind !== 'issue' || !isLive(parent)) return 'Choose an open Item';
  if (parent.parentId) return `One level only: ${view.numbers.get(parent.id) ?? 'this Item'} is a sub-item`;
  if (child && view.children.get(child.id)?.length) return 'One level only: this Item has sub-items';
  if (parent.id === child?.parentId) return 'Already its parent';
  if (child && view.more) return 'The plan is partial; sub-items may not be shown';
  return undefined;
}

export function itemPut(row: PlanRow, fields: BatchFields): BatchPut {
  return { action: 'put-planning-item', itemId: row.id, expectedVersion: row.version ?? 0, ...fields };
}

export function lastChildRank(view: PlanView, parent: PlanRow) {
  const last = view.children.get(parent.id)?.at(-1);
  return rankBetween(last ? effectiveRank(last) : null);
}

export function rankAfterParent(view: PlanView, child: PlanRow) {
  const group = view.groups.find(group => (group.initiative?.id ?? null) === (child.initiativeId ?? null));
  const top = group?.lines.filter(line => !line.row.parentId && line.row.id !== child.id) ?? [];
  const parentIndex = top.findIndex(line => line.row.id === child.parentId);
  const previous = parentIndex < 0 ? top.at(-1) : top[parentIndex];
  const next = parentIndex < 0 ? undefined : top[parentIndex + 1];
  return rankBetween(previous && effectiveRank(previous.row), next && effectiveRank(next.row));
}

/** The ordinary versioned batch, including the same Initiative comments as Move to. */
export function hierarchyMove(
  view: PlanView,
  rows: readonly PlanRow[],
  parent: PlanRow | null,
  initiativeId: string | null,
  order: string,
): BatchWrite[] {
  const [row, ...children] = rows;
  if (!row) return [];
  const changed = rows.filter(item => (item.initiativeId ?? null) !== initiativeId);
  const writes: BatchWrite[] = [
    itemPut(row, {
      ...(row.parentId || parent ? { parentId: parent?.id ?? null } : {}),
      ...(changed.includes(row) ? { initiativeId } : {}),
      order,
    }),
    ...children.filter(child => changed.includes(child)).map(child => itemPut(child, { initiativeId })),
  ];
  if (view.canEdit && changed.length) {
    const target = (initiativeId && view.byId.get(initiativeId)?.title) || 'No Initiative';
    const names = (items: readonly PlanRow[]) =>
      items.map(item => `${item.title} (${item.id.slice(0, 8)})`).join(', ');
    for (const source of new Set(changed.flatMap(item => (item.initiativeId ? [item.initiativeId] : []))))
      writes.push({
        action: 'comment-planning-item',
        itemId: source,
        text: `Moved out to ${target}: ${names(changed.filter(item => item.initiativeId === source))}.`,
      });
    if (initiativeId)
      writes.push({
        action: 'comment-planning-item',
        itemId: initiativeId,
        text: `Moved in: ${names(changed)}.`,
      });
  }
  if (writes.length > planningBatchLimit) throw new Error('Too many sub-items to move in one batch.');
  return writes;
}
