// SPDX-License-Identifier: Apache-2.0
// The planning counter's row and its in-transaction writer (Item 3fa3187d; read and backfill: projectPlanCounts.ts).
// Imported by projectWorkRecordWriter.ts, so it depends on nothing but types.
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export const PLAN_COUNTS = '_workStorePlanCounts';
const KEY = 'counts';
export const PLAN_STATUSES = ['proposed', 'open', 'in-progress', 'closed', 'abandoned'] as const;
type Status = (typeof PLAN_STATUSES)[number];
type Kind = 'issue' | 'initiative';
export type Tally = Record<Status, number>;
/** The stored row. `after` is the backfill cursor: roots keyed at or before it are counted; null once complete. */
export type PlanCounts = {
  /** 2: `g` is kept. A version 1 row is complete for members but has no groups; its backfill rebuilds it. */
  v: 1 | 2;
  done: boolean;
  after: string | null;
  issue: Tally;
  initiative: Tally;
  /** The UTC day `closedToday` counts Issues closed on. */
  day: string;
  closedToday: number;
  /** Version 2: counted Issues by what decides their public visibility besides their status (Item 76be0714), as
   * tallies in PLAN_STATUSES order: `h` for an Issue hidden itself, else `initiativeId|parentId`. An Issue with none
   * of the three is in no group (members' totals minus every group), so a plain plan's row keeps its bytes. */
  g?: Record<string, number[]>;
  /** Version 2: grouped Issues kept in no `g` entry once `g` held PLAN_GROUPS entries. Visitors never count them. */
  x?: number[];
};
/** At most this many `g` entries (each about 50 to 90 bytes); later groups go to `x`, so the row stays bounded. */
export const PLAN_GROUPS = 100;

export const zeroTally = (): Tally => ({ proposed: 0, open: 0, 'in-progress': 0, closed: 0, abandoned: 0 });
export const emptyPlanCounts = (done: boolean): PlanCounts => ({
  v: 2,
  done,
  after: done ? null : '',
  issue: zeroTally(),
  initiative: zeroTally(),
  day: '',
  closedToday: 0,
});
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Root = {
  collection: string;
  key?: string;
  generationId: Id<'projectWorkGenerations'>;
  value: string;
  planning?: { kind: string; status: string } | undefined;
};
/** A planning root's stored kind and status, from its index fields (as `planningPage` counts them) or else its value. */
function rootWords(root: Root | null) {
  if (root?.collection !== 'planningSearch' || !root.key) return null;
  let kind = root.planning?.kind,
    status = root.planning?.status;
  if (kind === undefined || status === undefined)
    try {
      ({ kind, status } = JSON.parse(root.value) as { kind?: string; status?: string });
    } catch {
      return null;
    }
  return { key: root.key, kind, status };
}
/** An Issue root's visibility group (PlanCounts.g); null for none. The fields publicPlanVisible reads. */
function rootGroup(root: Root) {
  let row: { hidden?: unknown; initiativeId?: unknown; parentId?: unknown };
  try {
    row = JSON.parse(root.value) as typeof row;
  } catch {
    return 'h'; // An unreadable root is never counted as public.
  }
  if (row.hidden) return 'h';
  const initiative = row.initiativeId ? String(row.initiativeId) : '';
  const parent = row.parentId ? String(row.parentId) : '';
  return initiative || parent ? `${initiative}|${parent}` : null;
}
/** A counted root's kind, status and (Issues) visibility group; null for Archived and Deleted roots, which no count
 * includes. */
export function planRootFacts(root: Root | null) {
  const words = rootWords(root);
  if (
    !words ||
    (words.kind !== 'issue' && words.kind !== 'initiative') ||
    !(PLAN_STATUSES as readonly string[]).includes(words.status!)
  )
    return null;
  const kind = words.kind as Kind;
  return {
    key: words.key,
    kind,
    status: words.status as Status,
    group: kind === 'issue' ? rootGroup(root!) : null,
  };
}
/** Move one Issue in or out of its group. An Issue joins its group's entry, or `x` when the entry is missing and
 * either `g` is full or `x` holds any Issue: no entry is created while `x` is in use, so an Issue that went to `x` can
 * only leave through `x`, never through an entry it was not counted in. Emptied entries stay until `pruneGroups`, so a
 * status move inside one group (its -1, then its +1) keeps the Issue in its entry. */
export function tallyGroup(counts: PlanCounts, group: string | null, status: Status, sign: 1 | -1) {
  if (group === null) return;
  const g = (counts.g ??= {});
  const entry =
    g[group] ??
    (sign > 0 && !counts.x?.some(n => n > 0) && Object.keys(g).length < PLAN_GROUPS
      ? (g[group] = PLAN_STATUSES.map(() => 0))
      : (counts.x ??= PLAN_STATUSES.map(() => 0)));
  const index = PLAN_STATUSES.indexOf(status);
  entry[index] = Math.max(0, entry[index]! + sign);
}
/** Remove empty entries, `g` and `x` once a transaction's moves are applied: an empty one counts no Issue. */
export function pruneGroups(counts: PlanCounts) {
  for (const [group, tally] of Object.entries(counts.g ?? {}))
    if (tally.every(n => n === 0)) delete counts.g![group];
  if (counts.g && !Object.keys(counts.g).length) delete counts.g;
  if (counts.x?.every(n => n === 0)) delete counts.x;
}
/** Unarchive or Restore puts back the status an Item left: bringing back an Item that left as closed is not a
 * closing; closing a shelved Item that left as anything else is. */
const shelvedClosed = (root: Root | null) => {
  const status = rootWords(root)?.status;
  if (status !== 'archived' && status !== 'deleted') return false;
  try {
    return (JSON.parse(root!.value) as { was?: string }).was === 'closed';
  } catch {
    return false;
  }
};

export const planCounter = (db: QueryCtx['db'], partition: Id<'projectWorkGenerations'>) =>
  db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', PLAN_COUNTS).eq('key', KEY),
    )
    .unique();

/** The row a new partition starts with: complete, so every root the writer adds is counted. */
export const planCountsBirth = (
  projectId: Id<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) => ({
  projectId,
  generationId,
  collection: PLAN_COUNTS,
  key: KEY,
  parent: '',
  position: 0,
  value: JSON.stringify(emptyPlanCounts(true)),
});

type Change = {
  key: string;
  kind: Kind;
  status: Status;
  group: string | null;
  sign: 1 | -1;
  closing: boolean;
};
/** Collects status and visibility-group moves in one transaction; `flush` reads and writes each touched counter
 * once, and only when a count moved (a title or body edit costs nothing). A partition with no counter row is left to its backfill. */
export function planCountsWriter(db: MutationCtx['db']) {
  const changes = new Map<Id<'projectWorkGenerations'>, Change[]>();
  return {
    change(before: Root | null, after: Root | null) {
      const was = planRootFacts(before),
        now = planRootFacts(after);
      if (was && now && was.kind === now.kind && was.status === now.status && was.group === now.group) return;
      const list = (generationId: Id<'projectWorkGenerations'>) => {
        let entries = changes.get(generationId);
        if (!entries) changes.set(generationId, (entries = []));
        return entries;
      };
      if (was) list(before!.generationId).push({ ...was, sign: -1, closing: false });
      if (now)
        list(after!.generationId).push({
          ...now,
          sign: 1,
          closing:
            now.kind === 'issue' &&
            now.status === 'closed' &&
            was?.status !== 'closed' &&
            !shelvedClosed(before),
        });
    },
    async flush() {
      for (const [partition, list] of changes) {
        const row = await planCounter(db, partition);
        if (!row) continue;
        const counts = JSON.parse(row.value) as PlanCounts;
        const today = utcDay(Date.now());
        if (counts.day !== today) Object.assign(counts, { day: today, closedToday: 0 });
        for (const change of list) {
          if (change.closing) counts.closedToday++;
          // Mid-backfill, a root past the cursor is counted when the backfill reaches it, with its status then.
          if (!counts.done && (counts.after === null || change.key > counts.after)) continue;
          counts[change.kind][change.status] = Math.max(0, counts[change.kind][change.status] + change.sign);
          if (counts.v === 2) tallyGroup(counts, change.group, change.status, change.sign);
        }
        pruneGroups(counts);
        const value = JSON.stringify(counts);
        if (value !== row.value) await db.patch(row._id, { value });
      }
      changes.clear();
    },
  };
}
