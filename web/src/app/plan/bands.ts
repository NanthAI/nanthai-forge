// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Group by a field (Item d3357f40, design cecab403): the Plan's rows in bands by Initiative (the default), owner, type
// or none, the same for the list and the board. Pure: it reshapes rows already read (projectPlanView:read and the
// settled pages), so switching the group costs no call. The board's column totals come from these same rows.
import { itemStatus, type PlanRow } from '../../../../src/planning-model';
import { NO_INITIATIVE } from './fold';
import type { PlanGroup, PlanLine, PlanView } from './model';
import type { GroupBy } from './query';

export type PlanBand = {
  /** The fold id: an Initiative id, NO_INITIATIVE, `owner:…`, `type:…` or `all`. */
  id: string;
  field: GroupBy;
  /** Shown name; an owner band's is the handle as set. */
  title: string;
  /** Initiative bands: the group with the whole plan's counts (the list's header uses the same). */
  group?: PlanGroup;
  /** No owner or no type: the band that holds the rest, always last. */
  rest?: true;
  lines: PlanLine[];
};

const settledLine = (row: PlanRow): PlanLine => ({ row, depth: 0, rank: 0, next: false });
const ownerKey = (owner: string) => owner.trim().replace(/^@/, '').toLowerCase();
const typeWord = (type: string) => type[0]!.toUpperCase() + type.slice(1);

/** The bands of a view. `settled` rows (done and dropped, when the scope shows them) join their Initiative's band or
 * the band of their field. With `hideEmpty` (a filter is set, or the scope shows no open work) a band with no rows is
 * left out; otherwise a live Initiative with nothing open still shows its band. */
export function planBands(
  view: PlanView,
  by: GroupBy,
  settled: readonly PlanRow[],
  { openShown, hideEmpty }: { openShown: boolean; hideEmpty: boolean },
): PlanBand[] {
  const open = openShown ? view.groups : [];
  if (by === 'initiative') {
    const bands = view.groups.map((group): PlanBand => ({
      id: group.initiative?.id ?? NO_INITIATIVE,
      field: by,
      title: group.initiative?.title ?? 'No Initiative',
      group,
      lines: openShown ? [...group.lines] : [],
    }));
    const byId = new Map(bands.map(band => [band.id, band]));
    for (const row of settled) {
      let band = byId.get(row.initiativeId ?? NO_INITIATIVE) ?? byId.get(NO_INITIATIVE);
      if (!band) {
        band = { id: NO_INITIATIVE, field: by, title: 'No Initiative', lines: [] };
        bands.push(band);
        byId.set(band.id, band);
      }
      band.lines.push(settledLine(row));
    }
    // An Initiative with nothing in it still shows its band; "No Initiative" is not a thing to show empty.
    return bands.filter(band => band.lines.length || (!hideEmpty && band.id !== NO_INITIATIVE));
  }
  const lines = [...open.flatMap(group => group.lines), ...settled.map(settledLine)];
  if (by === 'none')
    return lines.length || !hideEmpty ? [{ id: 'all', field: by, title: 'All Items', lines }] : [];
  const bands = new Map<string, PlanBand>();
  let rest: PlanBand | undefined;
  for (const line of lines) {
    const value = (by === 'owner' ? line.row.owner : line.row.type)?.trim() ?? '';
    // An owner of "@" normalizes to nothing: it joins the rest, never a second empty-keyed band.
    const key = by === 'owner' ? ownerKey(value) : value.toLowerCase();
    if (!key) {
      rest ??= {
        id: `${by}:`,
        field: by,
        title: by === 'owner' ? 'No one yet' : 'No type',
        rest: true,
        lines: [],
      };
      rest.lines.push(line);
      continue;
    }
    let band = bands.get(key);
    if (!band)
      bands.set(
        key,
        (band = { id: `${by}:${key}`, field: by, title: by === 'owner' ? value : typeWord(key), lines: [] }),
      );
    band.lines.push(line);
  }
  return [...bands.values(), ...(rest ? [rest] : [])];
}

export const boardColumns = [
  { status: 'proposed', title: 'Proposed', hint: '', about: 'Waits for a person to accept' },
  { status: 'planned', title: 'Planned', hint: 'in plan order', about: '' },
  { status: 'in-progress', title: 'In progress', hint: '', about: 'Has an open Lane' },
  { status: 'done', title: 'Done', hint: 'newest first', about: '' },
  { status: 'abandoned', title: 'Won’t do', hint: '', about: 'Closed with a reason' },
] as const;
export type BoardColumn = (typeof boardColumns)[number];

/** The top of a row's parent chain among `present`: itself when its parent is absent. A legacy deeper chain (A > B >
 * C) resolves to A; a cycle (A <> B) resolves to its smallest id, so exactly one of its members stays a row. */
function topOf(row: PlanRow, present: ReadonlyMap<string, PlanRow>) {
  const path: string[] = [];
  let at = row;
  while (at.parentId && at.parentId !== at.id && present.has(at.parentId)) {
    const loop = path.indexOf(at.id);
    if (loop >= 0) return path.slice(loop).sort()[0]!;
    path.push(at.id);
    at = present.get(at.parentId)!;
  }
  return at.id;
}

/** The board's rows: a sub-item under a row on the board is not a row of its own; its top Item shows it in its roll
 * (sub-items are not board rows in this cut). Bands keep their order. */
export function boardBands(bands: readonly PlanBand[]): PlanBand[] {
  const shown = new Map(bands.flatMap(band => band.lines.map(line => [line.row.id, line.row] as const)));
  return bands.map(band => ({
    ...band,
    lines: band.lines.filter(line => topOf(line.row, shown) === line.row.id),
  }));
}

/** Each column's total: the rows the board draws in it, so a header always equals its cells. */
export function columnTotals(bands: readonly PlanBand[]) {
  const totals = new Map<string, number>(boardColumns.map(column => [column.status, 0]));
  for (const band of bands)
    for (const line of band.lines) {
      const status = itemStatus[line.row.status];
      totals.set(status, (totals.get(status) ?? 0) + 1);
    }
  return totals;
}

/** Sub-items of each loaded top Item (the board's chain rule): how many, how many done, how many in progress. */
export function subItems(rows: Iterable<PlanRow>) {
  const present = new Map<string, PlanRow>();
  for (const row of rows)
    if (row.kind === 'issue' && row.status !== 'archived' && row.status !== 'deleted')
      present.set(row.id, row);
  const out = new Map<string, { total: number; done: number; running: number }>();
  for (const row of present.values()) {
    const top = topOf(row, present);
    if (top === row.id) continue;
    const entry = out.get(top) ?? { total: 0, done: 0, running: 0 };
    entry.total++;
    if (row.status === 'closed') entry.done++;
    if (row.status === 'in-progress') entry.running++;
    out.set(top, entry);
  }
  return out;
}
