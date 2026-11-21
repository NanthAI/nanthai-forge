// SPDX-License-Identifier: Apache-2.0
// The Plan screen as data (Items d3357f40, b7a0dff1): groups in plan order with their counts, the next free Item
// derived from state, the page sentence and the hand-order move. Every rule comes from src/planning-model.ts; this
// file only shapes it for the screen, so the CLI, the public plan and this screen never disagree.
import {
  effectiveRank,
  isLive,
  itemStatus,
  nextItem,
  planOrder,
  rankBetween,
  type PlanRow,
} from '../../../../src/planning-model';
import { initiativeBreakdown } from '../progress';

export type PlanRead = {
  rows: string;
  more: boolean;
  settled: readonly { initiativeId: string; done: number; dropped: number; atLeast: boolean }[];
  canEdit: boolean;
};

export type PlanLine = {
  row: PlanRow;
  depth: number;
  rank: number;
  next: boolean;
  blockedBy?: PlanRow;
  /** Its Initiative is not among the read Initiatives although all were read: it was archived or deleted (members
   * see the Item under No Initiative with this mark; public reads hide it). */
  shelvedInitiative?: true;
};
export type PlanGroup = {
  /** null: No Initiative. */
  initiative: PlanRow | null;
  lines: PlanLine[];
  live: number;
  inProgress: number;
  /** Planned (stored `open`) and proposed Items: with inProgress they make up `live`. */
  open: number;
  proposed: number;
  done: number;
  dropped: number;
  /** Live + done + dropped: every Item, the header's chip. */
  total: number;
  atLeast: boolean;
};
export type PlanView = {
  groups: PlanGroup[];
  next: PlanRow | null;
  live: number;
  planned: number;
  more: boolean;
  canEdit: boolean;
  byId: Map<string, PlanRow>;
};

export const parseRows = (read: PlanRead): PlanRow[] => {
  try {
    const rows = JSON.parse(read.rows);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};

/** A plain find over the loaded titles: every word must appear, in any order, ignoring case. */
export function matches(row: Pick<PlanRow, 'title' | 'id'>, find: string) {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${row.title} ${row.id.slice(0, 8)}`.toLowerCase();
  return words.every(word => hay.includes(word));
}

/** `orders` holds moves made here that the read has not caught up with yet; `keep` is the view's filter (type,
 * owner, relation, Initiative), applied to the listed lines only, so every count stays the whole plan's. */
export function planView(
  read: PlanRead,
  find = '',
  orders: ReadonlyMap<string, string> = new Map(),
  keep?: (row: PlanRow) => boolean,
): PlanView {
  const all = parseRows(read).map(row => (orders.has(row.id) ? { ...row, order: orders.get(row.id)! } : row));
  const byId = new Map(all.map(row => [row.id, row]));
  // Live Initiatives and the live Items; a settled Initiative's live Items show under it too.
  const items = all.filter(row => row.kind === 'issue' && isLive(row));
  const withItems = new Set(items.map(row => row.initiativeId).filter(Boolean));
  const shown = all.filter(row => row.kind === 'issue' || isLive(row) || withItems.has(row.id));
  const { next } = nextItem(shown);
  const open = new Set(items.map(row => row.id));
  const initiatives = new Set(all.filter(row => row.kind === 'initiative').map(row => row.id));
  const settled = new Map(read.settled.map(entry => [entry.initiativeId, entry]));
  const groups: PlanGroup[] = [];
  for (const { initiative, rows } of planOrder(shown)) {
    const done = initiative ? (settled.get(initiative.id)?.done ?? 0) : 0;
    const dropped = initiative ? (settled.get(initiative.id)?.dropped ?? 0) : 0;
    const live = rows.length;
    if (initiative && !isLive(initiative) && !live) continue;
    const lines: PlanLine[] = [];
    let top = 0;
    rows.forEach(({ row, depth }) => {
      // Sub-items share their parent's place; only top-level Items are numbered.
      if (!depth) top++;
      if ((find && !matches(row, find)) || (keep && !keep(row))) return;
      const blocker = row.relations?.find(
        relation => relation.kind === 'depends-on' && relation.id !== row.id && open.has(relation.id),
      );
      lines.push({
        row,
        depth,
        rank: top,
        next: row.id === next?.id,
        ...(blocker ? { blockedBy: byId.get(blocker.id) } : {}),
        ...(!initiative && !read.more && row.initiativeId && !initiatives.has(row.initiativeId)
          ? { shelvedInitiative: true as const }
          : {}),
      });
    });
    groups.push({
      initiative,
      lines,
      live,
      inProgress: rows.filter(({ row }) => row.status === 'in-progress').length,
      open: rows.filter(({ row }) => row.status === 'open').length,
      proposed: rows.filter(({ row }) => row.status === 'proposed').length,
      done,
      dropped,
      total: live + done + dropped,
      atLeast: initiative ? (settled.get(initiative.id)?.atLeast ?? false) : false,
    });
  }
  const count = (status: PlanRow['status']) => items.filter(row => row.status === status).length;
  return {
    groups,
    next,
    live: items.length,
    planned: count('open'),
    more: read.more,
    canEdit: read.canEdit,
    byId,
  };
}

/** The page sentence points to available work. Project totals come from the shared Standing row. */
export function planSentence(view: PlanView): { bold: string; rest: string } {
  if (view.next) return { bold: `The next free Item is ${view.next.title}.`, rest: '' };
  if (view.more) return { bold: 'No free Item among the Items shown.', rest: '' };
  if (view.planned) return { bold: 'Every planned Item is owned, in a Lane or blocked.', rest: '' };
  if (view.live) return { bold: 'No Items are ready to pick up.', rest: '' };
  return { bold: 'No open Items.', rest: 'Add an Item, or let an agent propose one.' };
}

/** The visible status word for a row. */
export const statusOf = (row: Pick<PlanRow, 'status'>) => itemStatus[row.status];

/**
 * The rank a moved row takes: strictly between its new neighbours among its siblings (same parent, or top level),
 * so no other Item is rewritten. `ids` is the group's line order after the move.
 */
export function movedRank(lines: readonly PlanLine[], ids: readonly string[], movedId: string) {
  const byId = new Map(lines.map(line => [line.row.id, line]));
  const moved = byId.get(movedId);
  if (!moved) return null;
  const sibling = (id: string) => {
    const line = byId.get(id);
    return (
      line &&
      line.row.id !== movedId &&
      (line.row.parentId ?? null) === (moved.row.parentId ?? null) &&
      line.depth === moved.depth
    );
  };
  const at = ids.indexOf(movedId);
  const before = ids.slice(0, at).reverse().find(sibling);
  const after = ids.slice(at + 1).find(sibling);
  const rank = (id: string | undefined) => (id ? effectiveRank(byId.get(id)!.row) : undefined);
  return rankBetween(rank(before), rank(after));
}

/** The rank a moved Initiative takes: strictly between its new neighbours among the Initiatives shown, the same one
 * write as an Item move (docs/planning.md, Hand order). `ids` is the Initiatives' order after the move. */
export function movedInitiativeRank(
  initiatives: readonly PlanRow[],
  ids: readonly string[],
  movedId: string,
) {
  const byId = new Map(initiatives.map(row => [row.id, row]));
  const at = ids.indexOf(movedId);
  if (at < 0 || !byId.has(movedId)) return null;
  const rank = (id: string | undefined) => (id && byId.has(id) ? effectiveRank(byId.get(id)!) : undefined);
  return rankBetween(rank(ids[at - 1]), rank(ids[at + 1]));
}

/** An Initiative's breakdown from the one progress definition (web/src/app/progress.ts). */
export const groupBreakdown = (
  group: Pick<PlanGroup, 'done' | 'inProgress' | 'open' | 'proposed' | 'dropped' | 'atLeast'>,
) =>
  initiativeBreakdown({
    done: group.done,
    inProgress: group.inProgress,
    open: group.open,
    proposed: group.proposed,
    removed: group.dropped,
    atLeast: group.atLeast,
  });

/** Done-when lines written in capture become the body's task lines (docs/planning.md, Status). */
export function captureBody(doneWhen: string) {
  const lines = doneWhen
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s+)?/, '').trim())
    .filter(Boolean);
  return lines.length ? `Done when:\n${lines.map(line => `- [ ] ${line}`).join('\n')}\n` : '';
}
