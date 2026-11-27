// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure: also runs in the Convex non-Node runtime and in the web app. No I/O.
//
// The shared planning contract (Item d3357f40, docs/planning.md). The web Plan place, discussions, public
// discovery, backlog bulk and import all read planning through these words and rules, never a copy:
// - one record kind, the Item (wire kind `issue`; `item` is accepted as an alias on input), grouped by Initiatives;
// - five visible statuses mapped from the stored words, which stay unchanged for replay;
// - one hand order: an optional fractional rank, and creation order for every Item never moved;
// - "next" derived from state, never stored;
// - Initiative progress from counted children, never a typed percentage;
// - one public-plan visibility rule for every public read.
// The stored schema (src/work-planning-types.ts) keeps its own rank pattern and relation kinds so the CLI
// loads no extra module; tests/planning-model.test.mjs ties them. Task references and counts are shared with
// the search projection.

export type StoredStatus =
  | 'proposed'
  | 'open'
  | 'in-progress'
  | 'closed'
  | 'abandoned'
  | 'archived'
  | 'deleted';
export type ItemStatus =
  | 'proposed'
  | 'planned'
  | 'in-progress'
  | 'done'
  | 'abandoned'
  | 'archived'
  | 'deleted';

/** The visible status of a stored status word. Stored words never change: old operations replay exactly. */
export const itemStatus: Record<StoredStatus, ItemStatus> = {
  proposed: 'proposed',
  open: 'planned',
  'in-progress': 'in-progress',
  closed: 'done',
  abandoned: 'abandoned',
  archived: 'archived',
  deleted: 'deleted',
};
export const itemStatusLabel: Record<ItemStatus, string> = {
  proposed: 'Proposed',
  planned: 'Planned',
  'in-progress': 'In progress',
  done: 'Done',
  abandoned: 'Abandoned',
  archived: 'Archived',
  deleted: 'Deleted',
};

/** Owner decision 2026-11-12: three default types. Projects may add their own labels (at most 32 characters). */
export const defaultItemTypes = ['idea', 'task', 'bug'] as const;
/** Why an Item was abandoned; free text stays allowed in `reason`, these are the one-press choices. */
export const abandonReasons = {
  'wont-do': "Won't do",
  duplicate: 'Duplicate',
  superseded: 'Superseded',
} as const;
export const relationKinds = ['depends-on', 'duplicate-of', 'related'] as const;
export type RelationKind = (typeof relationKinds)[number];
export const inverseRelationLabel: Record<RelationKind, string> = {
  'depends-on': 'Blocks',
  'duplicate-of': 'Duplicated by',
  related: 'Related',
};

// ---- Hand order -------------------------------------------------------------------------------------------------
// A rank is a string over DIGITS compared byte-wise. An Item that was never moved has no stored rank and sorts by
// legacyRank(position): its creation position, fixed-width under the prefix "L". A move stores rankBetween(the two
// neighbours' effective ranks), so moved and unmoved Items interleave without rewriting anyone else.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const rankPattern = /^[0-9A-Za-z]{0,63}[1-9A-Za-z]$/;

/** The effective rank of an Item never moved: its stable creation position. */
export function legacyRank(position: number): string {
  let digits = '';
  let rest = Math.max(0, Math.floor(position));
  do {
    digits = DIGITS[rest % 62] + digits;
    rest = Math.floor(rest / 62);
  } while (rest > 0);
  // Ends in a non-zero digit, so a rank can always be made between it and the next one.
  return `L${digits.padStart(6, '0')}V`;
}

/** A rank strictly between `before` and `after` (either may be absent: top or bottom of the list). Never ends in
 * "0", so there is always room below it. With no `after` it keeps all of `before` as its prefix, so an Item moved
 * after the last one still sorts before Items created later; rankAtEnd gives a shorter rank for that move. */
export function rankBetween(before?: string | null, after?: string | null): string {
  const a = before ?? '';
  let b: string | undefined = after ?? undefined;
  if (b !== undefined && a >= b) throw new RangeError('rankBetween: `before` must sort before `after`.');
  let out = '';
  for (let index = 0; ; index++) {
    const low = index < a.length ? DIGITS.indexOf(a[index]!) : 0;
    const high =
      b === undefined
        ? index < a.length
          ? low
          : DIGITS.length
        : index < b.length
          ? DIGITS.indexOf(b[index]!)
          : 0;
    if (high - low > 1) return out + DIGITS[Math.floor((low + high) / 2)];
    out += DIGITS[low];
    // b's next digit is one higher: anything after this prefix already sorts before b.
    if (high - low === 1) b = undefined;
  }
}

/** The rank for "move to the end": after `last`, and before any Item created later. `maxPosition` is the highest
 * creation position the caller has seen; every later Item gets a higher one. */
export const rankAtEnd = (last: string | null | undefined, maxPosition: number) => {
  const bound = legacyRank(maxPosition + 1);
  return last && last < bound ? rankBetween(last, bound) : rankBetween(last);
};

export const effectiveRank = (row: { order?: string | null; position: number }) =>
  row.order ?? legacyRank(row.position);

// ---- Rows -------------------------------------------------------------------------------------------------------
/** The compact planning row every list reads: no body. `position` is the stable creation position. */
export type PlanRow = {
  id: string;
  kind: 'issue' | 'initiative';
  title: string;
  status: StoredStatus;
  position: number;
  version?: number;
  initiativeId?: string | null;
  parentId?: string | null;
  order?: string | null;
  type?: string | null;
  owner?: string | null;
  relations?: readonly { kind: RelationKind; id: string }[];
  hidden?: boolean;
  /** [ticked, total] Done-when lines; null when the body has none, undefined when not known. */
  doneWhen?: readonly [number, number] | null;
  /** At least one linked Lane is still open for work. */
  inLane?: boolean;
  /** Archived and Deleted rows only (Item 4c9e961e): the status it left, when it moved, and who moved it. */
  was?: StoredStatus;
  at?: string;
  by?: string;
  purgeAt?: number;
};

const live = (status: StoredStatus) => status === 'proposed' || status === 'open' || status === 'in-progress';
export const isLive = (row: Pick<PlanRow, 'status'>) => live(row.status);

const byRank = (left: PlanRow, right: PlanRow) => {
  const a = effectiveRank(left),
    b = effectiveRank(right);
  return a < b ? -1 : a > b ? 1 : left.position - right.position;
};

/**
 * The one plan order: Initiatives by their own rank, then Items with no Initiative ("No Initiative", last). Within a
 * group Items by rank, each followed by its sub-items. A sub-item whose parent is absent sits in its own group as an
 * Item. Live sub-items also sit in their own group when their parent is settled; deeper nesting is flattened.
 */
export function planOrder(rows: readonly PlanRow[]) {
  const initiatives = rows.filter(row => row.kind === 'initiative').sort(byRank);
  const known = new Set(initiatives.map(row => row.id));
  const items = rows.filter(row => row.kind === 'issue');
  const present = new Map(items.map(row => [row.id, row]));
  const parentOf = (row: PlanRow) => {
    if (!row.parentId || row.parentId === row.id) return undefined;
    const parent = present.get(row.parentId);
    return parent && (!isLive(row) || isLive(parent)) ? parent.id : undefined;
  };
  const children = new Map<string, PlanRow[]>();
  for (const row of items) {
    const parent = parentOf(row);
    if (parent) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(row);
      else children.set(parent, [row]);
    }
  }
  const placed = new Set<string>();
  const walk = (row: PlanRow, depth: number, out: { row: PlanRow; depth: number }[]) => {
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push({ row, depth: Math.min(depth, 1) });
    for (const child of (children.get(row.id) ?? []).sort(byRank)) walk(child, depth + 1, out);
  };
  const group = (initiativeId: string | null) => {
    const out: { row: PlanRow; depth: number }[] = [];
    for (const row of items
      .filter(
        row => (row.initiativeId && known.has(row.initiativeId) ? row.initiativeId : null) === initiativeId,
      )
      .filter(row => !parentOf(row))
      .sort(byRank))
      walk(row, 0, out);
    return out;
  };
  const groups = [
    ...initiatives.map(initiative => ({ initiative, rows: group(initiative.id) })),
    { initiative: null, rows: group(null) },
  ];
  // Cycles (a parent chain that loops) are never dropped: anything unplaced joins No Initiative.
  for (const row of items.sort(byRank)) if (!placed.has(row.id)) walk(row, 0, groups.at(-1)!.rows);
  return groups;
}

export type SkipReason = 'owned' | 'in-lane' | 'blocked';
/**
 * "Next" is the first Planned Item in plan order with no owner, Lane, live dependency or live direct sub-item.
 * Earlier Planned Items are returned with the reason each was skipped. Only Items in the loaded rows can block Next.
 */
export function nextItem(rows: readonly PlanRow[], limitSkipped = 10) {
  const open = new Set<string>();
  const firstLiveChild = new Map<string, PlanRow>();
  for (const row of rows) {
    if (row.kind !== 'issue' || !isLive(row)) continue;
    open.add(row.id);
    if (!row.parentId || row.parentId === row.id) continue;
    const first = firstLiveChild.get(row.parentId);
    if (!first || byRank(row, first) < 0) firstLiveChild.set(row.parentId, row);
  }
  const skipped: { id: string; title: string; reason: SkipReason; blockedBy?: string }[] = [];
  for (const { rows: group } of planOrder(rows))
    for (const { row } of group) {
      if (row.status !== 'open') continue;
      const dependency = row.relations?.find(
        relation => relation.kind === 'depends-on' && relation.id !== row.id && open.has(relation.id),
      );
      const blockedBy = dependency?.id ?? firstLiveChild.get(row.id)?.id;
      const reason: SkipReason | null = row.owner
        ? 'owned'
        : row.inLane
          ? 'in-lane'
          : blockedBy
            ? 'blocked'
            : null;
      if (!reason) return { next: row, skipped };
      if (skipped.length < limitSkipped)
        skipped.push({ id: row.id, title: row.title, reason, ...(blockedBy ? { blockedBy } : {}) });
    }
  return { next: null, skipped };
}

/** Counted progress of a set of Items (an Initiative's children with their sub-items): one tick per Item. */
export function progress(rows: readonly Pick<PlanRow, 'status'>[]) {
  const counts = { done: 0, inProgress: 0, notStarted: 0, dropped: 0 };
  let total = 0;
  for (const row of rows) {
    // Archived and Deleted Items are out of every count (Item 4c9e961e).
    if (row.status === 'archived' || row.status === 'deleted') continue;
    total++;
    if (row.status === 'closed') counts.done++;
    else if (row.status === 'in-progress') counts.inProgress++;
    else if (row.status === 'abandoned') counts.dropped++;
    else counts.notStarted++;
  }
  return { ...counts, live: counts.inProgress + counts.notStarted, total };
}

export { doneWhenCounts } from './planning-search.js';

// ---- Public plan visibility -------------------------------------------------------------------------------------
/** Project setting. Absent means public: on a public project anyone may read the plan (owner decision 2026-11-16). */
export type PlanVisibility = 'public' | 'members';

/**
 * The one visibility rule for every public read of the plan (web, public API, share cards, sitemap, agent lookup) and
 * for public counts. A hidden Item hides its sub-items; a hidden Initiative hides every Item in it. Pass the row's
 * Initiative and parent when it names them: `undefined` means "not looked up" and fails closed; `null` means looked up
 * and absent (a dangling reference hides nothing).
 */
export function publicPlanVisible(input: {
  projectVisibility: 'public' | 'private';
  planVisibility?: PlanVisibility;
  item: Pick<PlanRow, 'hidden' | 'initiativeId' | 'parentId'> & { status?: string | undefined };
  initiative?: (Pick<PlanRow, 'hidden'> & { status?: string | undefined }) | null;
  parent?: (Pick<PlanRow, 'hidden' | 'initiativeId'> & { status?: string | undefined }) | null;
  parentInitiative?: (Pick<PlanRow, 'hidden'> & { status?: string | undefined }) | null;
  promoted?: true;
}): boolean {
  if (input.projectVisibility !== 'public' || input.planVisibility === 'members') return false;
  if (concealed(input.item)) return false;
  if (input.item.initiativeId && (input.initiative === undefined || concealed(input.initiative)))
    return false;
  if (input.item.parentId && !input.promoted) {
    if (input.parent === undefined || concealed(input.parent)) return false;
    if (
      input.parent?.initiativeId &&
      (input.parentInitiative === undefined || concealed(input.parentInitiative))
    )
      return false;
  }
  return true;
}
/** Hidden, Archived and Deleted rows are never public, and neither is anything inside them (Item 4c9e961e). */
const concealed = (row: { hidden?: boolean | undefined; status?: string | undefined } | null) =>
  Boolean(row?.hidden || row?.status === 'archived' || row?.status === 'deleted');

// ---- Agent list rows --------------------------------------------------------------------------------------------
/** What an agent list reply carries per Item: order, id, status, owner, Done-when and title, without bodies. */
export function compactRows(rows: readonly PlanRow[]) {
  return planOrder(rows).flatMap(({ initiative, rows: group }) =>
    group.map(({ row, depth }, index) => ({
      order: index + 1,
      id: row.id,
      status: itemStatus[row.status],
      owner: row.owner ?? null,
      doneWhen: row.doneWhen ? `${row.doneWhen[0]}/${row.doneWhen[1]}` : null,
      title: row.title,
      initiativeId: initiative?.id ?? null,
      ...(depth ? { parentId: row.parentId } : {}),
    })),
  );
}
