// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

type LiveCounts = { open: number; inProgress: number; proposed: number };
export type PlanRead = {
  rows: string;
  more: boolean;
  liveMore?: boolean;
  settled: readonly {
    initiativeId: string;
    done: number;
    dropped: number;
    atLeast: boolean;
    live?: LiveCounts;
  }[];
  canEdit: boolean;
  closeReceipt?: string | undefined;
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
  liveAtLeast: boolean;
};
export type PlanView = {
  groups: PlanGroup[];
  initiativeGroups: ReadonlyMap<string, PlanGroup>;
  next: PlanRow | null;
  live: number;
  planned: number;
  /** Left: planned plus proposed Items, the figure the standing line calls Left (web/src/app/progress.ts). */
  left: number;
  inProgress: number;
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
  const items = all.filter(row => row.kind === 'issue' && isLive(row));
  const initiatives = all.filter(row => row.kind === 'initiative');
  const known = new Set(initiatives.map(row => row.id));
  const emptyLive: LiveCounts = { open: 0, inProgress: 0, proposed: 0 };
  const liveByInitiative = new Map<string | null, LiveCounts>();
  // Tree placement can follow a parent in a different Initiative. Counts follow stored membership.
  for (const row of items) {
    const id = row.initiativeId || null;
    const key = id && known.has(id) ? id : null;
    let counts = liveByInitiative.get(key);
    if (!counts) liveByInitiative.set(key, (counts = { ...emptyLive }));
    if (row.status === 'in-progress') counts.inProgress++;
    else if (row.status === 'proposed') counts.proposed++;
    else counts.open++;
  }
  const settled = new Map(read.settled.map(entry => [entry.initiativeId, entry]));
  const progressFor = (initiative: PlanRow | null) => {
    const summary = initiative && settled.get(initiative.id);
    const counts = summary?.live ?? liveByInitiative.get(initiative?.id ?? null) ?? emptyLive;
    const live = counts.open + counts.inProgress + counts.proposed;
    const done = summary?.done ?? 0;
    const dropped = summary?.dropped ?? 0;
    return {
      initiative,
      ...counts,
      live,
      done,
      dropped,
      total: live + done + dropped,
      atLeast: summary?.atLeast ?? initiative !== null,
      liveAtLeast: !summary?.live && (read.liveMore ?? read.more),
    };
  };
  const initiativeGroups = new Map<string, PlanGroup>(
    initiatives.map(row => [row.id, { ...progressFor(row), lines: [] }]),
  );
  const shown = [...initiatives.filter(row => isLive(row) || initiativeGroups.get(row.id)!.live), ...items];
  const { next } = nextItem(shown);
  const open = new Set(items.map(row => row.id));
  const groups: PlanGroup[] = [];
  for (const { initiative, rows } of planOrder(shown)) {
    const group: PlanGroup = initiative
      ? initiativeGroups.get(initiative.id)!
      : { ...progressFor(null), lines: [] };
    let top = 0;
    rows.forEach(({ row, depth }) => {
      // Sub-items share their parent's place; only top-level Items are numbered.
      if (!depth) top++;
      if ((find && !matches(row, find)) || (keep && !keep(row))) return;
      const blocker = row.relations?.find(
        relation => relation.kind === 'depends-on' && relation.id !== row.id && open.has(relation.id),
      );
      group.lines.push({
        row,
        depth,
        rank: top,
        next: row.id === next?.id,
        ...(blocker ? { blockedBy: byId.get(blocker.id) } : {}),
        ...(!initiative && !read.more && row.initiativeId && !known.has(row.initiativeId)
          ? { shelvedInitiative: true as const }
          : {}),
      });
    });
    groups.push(group);
  }
  const count = (status: PlanRow['status']) => items.filter(row => row.status === status).length;
  return {
    groups,
    initiativeGroups,
    next,
    live: items.length,
    planned: count('open'),
    left: count('open') + count('proposed'),
    inProgress: count('in-progress'),
    more: read.more,
    canEdit: read.canEdit,
    byId,
  };
}

/** The project's figures the sentence uses: the standing line's Left and In progress (progress.ts), and how many
 * in-progress Items wait on the reader (lane-words.ts). Without them the sentence counts the Plan's own rows. */
export type PlanFigures = {
  left: number;
  inProgress: number;
  atLeast: boolean;
  waitOnYou: number;
  /** Some in-progress Items were past the reads that say who waits: the tally is a lower bound. */
  waitAtLeast?: boolean;
};

const items = (n: number, atLeast: boolean) =>
  `${n.toLocaleString()}${atLeast ? '+' : ''} ${n === 1 && !atLeast ? 'Item is' : 'Items are'}`;

/** The page sentence, as the board mock says it (02-plan-board): "7 Items are left; next is X. 5 in progress, 2 of
 * them wait on you." Left and In progress are the standing line's own figures, so the two never disagree. */
export function planSentence(view: PlanView, figures?: PlanFigures | null): { bold: string; rest: string } {
  const left = figures?.left ?? view.left;
  const inProgress = figures?.inProgress ?? view.inProgress;
  const atLeast = figures ? figures.atLeast : view.more;
  const waits = figures?.waitOnYou ?? 0;
  const waitsMore = figures?.waitAtLeast ? '+' : '';
  const rest = inProgress
    ? `${inProgress.toLocaleString()}${atLeast ? '+' : ''} in progress${
        waits
          ? `, ${waits.toLocaleString()}${waitsMore} of them ${waits === 1 && !waitsMore ? 'waits' : 'wait'} on you`
          : ''
      }.`
    : '';
  if (!left && !inProgress && !view.live)
    return { bold: 'No open Items.', rest: 'Add an Item, or let an agent propose one.' };
  const head = left || atLeast ? `${items(left, atLeast)} left` : 'No Items are left';
  if (view.next) return { bold: `${head}; next is ${view.next.title}.`, rest };
  const why = view.more
    ? 'no free Item among the Items shown'
    : view.planned
      ? 'every planned Item is owned, in a Lane or blocked'
      : 'none is ready to pick up';
  return { bold: left || atLeast ? `${head}; ${why}.` : `${head}.`, rest };
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
  group: Pick<PlanGroup, 'done' | 'inProgress' | 'open' | 'proposed' | 'dropped' | 'atLeast' | 'liveAtLeast'>,
) =>
  initiativeBreakdown({
    done: group.done,
    inProgress: group.inProgress,
    open: group.open,
    proposed: group.proposed,
    removed: group.dropped,
    atLeast: group.atLeast,
    liveAtLeast: group.liveAtLeast,
  });

/** Done-when lines written in capture become the body's task lines (docs/planning.md, Status). */
export function captureBody(doneWhen: string) {
  const lines = doneWhen
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s+)?/, '').trim())
    .filter(Boolean);
  return lines.length ? `Done when:\n${lines.map(line => `- [ ] ${line}`).join('\n')}\n` : '';
}
