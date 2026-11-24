// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { effectiveRank, rankBetween, type PlanRow } from '../../../../src/planning-model';
import { planningBatchLimit, type BatchWrite } from '../../../../src/planning-batch';
import { ordinal } from '../../ds/behaviour/shared';
import { hierarchyMove, itemPut, parentRefusal } from './hierarchy';
import type { PlanGroup, PlanView } from './model';

export type DropPlace =
  | { position: 'before' | 'after' | 'on'; id: string }
  | {
      position: 'group';
      initiativeId: string | null;
    };
export type DropMove = {
  label: string;
  depth: 0 | 1;
  order: string;
  initiativeId: string | null;
  parent: PlanRow | null;
};
export type DropChoice = DropMove | { label: string; refused: true };
const refusal = (label: string): DropChoice => ({ label, refused: true });
const groupId = (group: PlanGroup) => group.initiative?.id ?? null;

/** Consecutive edges within one sibling scope are the same seam. Keep both edges when the depth changes. */
export function keyboardDropPlaces(view: PlanView, folded: (group: PlanGroup) => boolean): DropPlace[] {
  return view.groups.flatMap(group => [
    { position: 'group', initiativeId: groupId(group) },
    ...(folded(group)
      ? []
      : group.lines.flatMap(({ row }, index, lines): DropPlace[] => [
          ...(index === 0 || (lines[index - 1]?.row.parentId ?? null) !== (row.parentId ?? null)
            ? [{ position: 'before', id: row.id } as const]
            : []),
          { position: 'on', id: row.id },
          { position: 'after', id: row.id },
        ])),
  ]);
}

/** One index over the loaded plan per revision. Hovering and moving between targets do no reads and inspect only
 * the destination, source and their adjacent ranks. A displayed row that lost its parent is not a top-level seam. */
export function planDropTargets(view: PlanView) {
  const itemGroups = new Map<string, PlanGroup>();
  const groups = new Map(view.groups.map(group => [groupId(group), group]));
  const tops = new Map<string | null, PlanRow[]>();
  const indexes = new Map<string, number>();
  for (const group of view.groups) {
    const top: PlanRow[] = [];
    for (const { row } of group.lines) {
      itemGroups.set(row.id, group);
      if (row.parentId) continue;
      indexes.set(row.id, top.length);
      top.push(row);
    }
    tops.set(groupId(group), top);
  }
  const childScopes = new Map<string, Map<string | null, number>>();
  for (const [id, children] of view.children) {
    const counts = new Map<string | null, number>();
    children.forEach((row, index) => {
      indexes.set(row.id, index);
      const scope = row.initiativeId ?? null;
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    });
    childScopes.set(id, counts);
  }

  return (moving: PlanRow, place: DropPlace): DropChoice => {
    const target = place.position === 'group' ? undefined : view.byId.get(place.id);
    const group =
      place.position === 'group' ? groups.get(place.initiativeId) : target && itemGroups.get(target.id);
    if (!group || (place.position !== 'group' && !target)) return refusal('This place is no longer shown');
    if (target?.id === moving.id) return refusal('This Item');
    const onto = place.position === 'on';
    const parent = (onto ? target : target?.parentId ? view.byId.get(target.parentId) : null) ?? null;
    if (target?.parentId && !onto && !parent) return refusal('Its parent is not shown');
    const initiativeId = parent ? (parent.initiativeId ?? null) : groupId(group);
    const across = initiativeId !== (moving.initiativeId ?? null);
    const parentChanged = (parent?.id ?? null) !== (moving.parentId ?? null);
    if (parent && (onto || parentChanged)) {
      const reason = parentRefusal(view, moving, parent);
      if (reason) return refusal(reason);
    }
    if (across && !parent) {
      if (!view.canEdit) return refusal('Only the owner can move an Item directly to another Initiative');
      if (view.more) return refusal('The plan is partial; sub-items may not be shown');
      // Each distinct non-empty origin and the non-empty destination get one note. A legacy child may have
      // different stored membership, or already be in the destination and need no write.
      const scopes = childScopes.get(moving.id);
      const childWrites = (view.children.get(moving.id)?.length ?? 0) - (scopes?.get(initiativeId) ?? 0);
      const origins =
        (scopes?.size ?? 0) -
        Number(scopes?.has(null) ?? false) -
        Number(Boolean(initiativeId && scopes?.has(initiativeId))) +
        Number(Boolean(moving.initiativeId && !scopes?.has(moving.initiativeId)));
      if (1 + childWrites + origins + Number(Boolean(initiativeId)) > planningBatchLimit)
        return refusal('Too many sub-items to move in one batch');
    }
    const siblings = parent ? (view.children.get(parent.id) ?? []) : (tops.get(initiativeId) ?? []);
    const from = across || parentChanged ? -1 : (indexes.get(moving.id) ?? -1);
    const seam = target ? indexes.get(target.id) : undefined;
    if (!onto && target && seam === undefined) return refusal('This place has no hand rank');
    const at = onto ? siblings.length : seam === undefined ? 0 : seam + Number(place.position === 'after');
    const to = from >= 0 && from < at ? at - 1 : at;
    if (from === to) return refusal('Already in this position');
    const neighbor = (index: number) => siblings[from >= 0 && index >= from ? index + 1 : index];
    const before = neighbor(to - 1);
    const after = neighbor(to);
    const low = before && effectiveRank(before);
    const high = after && effectiveRank(after);
    if (low !== undefined && high !== undefined && low >= high)
      return refusal('These Items have the same hand rank');
    const parentNumber = parent && view.numbers.get(parent.id);
    const childNumber = parentNumber ? ` · becomes ${parentNumber}.${to + 1}` : '';
    const placement = onto
      ? `Put under${childNumber}`
      : parent
        ? `Under ${parentNumber || parent.title}${childNumber}`
        : `Top level · ${ordinal(to + 1)}`;
    const destination = (initiativeId && view.byId.get(initiativeId)?.title) || 'No Initiative';
    return {
      label: across ? `Moves to ${destination} · ${placement}` : placement,
      depth: parent ? 1 : 0,
      initiativeId,
      parent,
      order: rankBetween(low, high),
    };
  };
}

/** Same-scope reorder does not rewrite hierarchy fields or need tally coverage. Cross-group moves keep the
 * loaded open children together and add the existing Move in/out notes. The caller submits atomically. */
export function dropWrites(view: PlanView, moving: PlanRow, move: DropMove): BatchWrite[] {
  const across = (moving.initiativeId ?? null) !== move.initiativeId;
  if (!across && (moving.parentId ?? null) === (move.parent?.id ?? null))
    return [itemPut(moving, { order: move.order })];
  const children = across && !move.parent ? (view.children.get(moving.id) ?? []) : [];
  return hierarchyMove(view, [moving, ...children], move.parent, move.initiativeId, move.order);
}
