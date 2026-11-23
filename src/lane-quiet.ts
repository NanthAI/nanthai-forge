// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** A Lane with no save, sync or start for this long reads as stopped mid-task (Loose ends, convex/projectLooseEnds.ts)
 * and, beside a busier Lane of the same Item, as replaced by it (the Lanes yard, web/src/app/lanes/model.ts). */
export const QUIET_MS = 90 * 60_000;

/** Recent activity protects a Lane from Loose ends advice, independently of its last save. */
export const LOOSE_ENDS_ACTIVITY_MS = 30 * 60_000;

type LooseEnd = { laneId: string; replacedBy?: string; next?: string; heldBy?: string };
type Listed<Row> = { reported: true; rows: Row[]; more: boolean; continueCursor?: string | null };
type Group<Row> = Listed<Row> | { reported: false; why: string };
type QuietGroups<Row> = {
  idle?: Group<Row> | null;
  stopped?: Listed<Row>;
  checked?: Group<Row> | null;
  active?: Listed<Row>;
};

/** A page cursor describes examined candidates, even if some belong in the activity group. */
export function withLooseEndsHolders<Row extends LooseEnd, Groups extends QuietGroups<Row>>(
  groups: Groups,
  holders: ReadonlyMap<string, string>,
) {
  if (!holders.size) return groups;
  const active = [...(groups.active?.rows ?? [])];
  const split = (group: Group<Row> | null | undefined) => {
    if (!group?.reported) return group;
    const quiet = group.rows.filter(row => {
      const heldBy = holders.get(row.laneId);
      if (!heldBy) return true;
      const held = { ...row, heldBy };
      delete held.replacedBy;
      delete held.next;
      active.push(held);
      return false;
    });
    return { ...group, rows: quiet };
  };
  const idle = split(groups.idle);
  const stopped = split(groups.stopped);
  const checked = split(groups.checked);
  return {
    ...groups,
    ...(idle ? { idle } : {}),
    ...(checked ? { checked } : {}),
    ...(stopped ? { stopped } : {}),
    ...(active.length ? { active: { reported: true, rows: active, more: false } } : {}),
  };
}
