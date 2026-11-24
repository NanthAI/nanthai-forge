// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The planning counter's row and its in-transaction writer (Item 3fa3187d; read and backfill: projectPlanCounts.ts).
// Imported by projectWorkRecordWriter.ts; keep dependencies below the work writer to avoid a cycle.
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { PlanningItem } from '../src/work-planning-types';
import type { RollupCounts } from '../src/planning-rollup';
import {
  addRollupCounts,
  emptyRollupCounts,
  rollupMembershipChanges,
  type RollupScope,
} from '../src/planning-rollup-membership';
import { applyRollupDeltas, readRollupScope, rollupScopeReads } from './projectPlanRollupStore';

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
  /** Exact direct scope tallies: absent on older partitions, key through the imported prefix, null when ready. */
  scopeThrough?: string | null;
  /** A bad delta invalidates automation, not the source Item write. Only an explicit repair can clear it. */
  scopeBlocked?: true;
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
  projectId: Id<'hostedProjects'>;
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
type ScopeMember = Pick<PlanningItem, 'status' | 'parentId' | 'initiativeId'>;
type ScopeFields = Pick<PlanningItem, 'parentId' | 'initiativeId' | 'hidden'>;
function scopeFields(root: Root): ScopeFields | null {
  try {
    return JSON.parse(root.value) as ScopeFields;
  } catch {
    return null;
  }
}

/** An Issue root's visibility group (PlanCounts.g); null for none. The fields publicPlanVisible reads. */
function rootGroup(row: ScopeFields | null) {
  if (!row || row.hidden) return 'h'; // An unreadable root is never counted as public.
  const initiative = row.initiativeId || '';
  const parent = row.parentId || '';
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
  const status = words.status as Status;
  const fields = kind === 'issue' ? scopeFields(root!) : null;
  const member: ScopeMember | null = fields
    ? { status, parentId: fields.parentId, initiativeId: fields.initiativeId }
    : null;
  return { key: words.key, kind, status, group: kind === 'issue' ? rootGroup(fields) : null, member };
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

/** Internal child-existence guard: exact across hidden and settled children; shelved Items do not count.
 * Supply the coverage header when the caller already holds it so the guard costs one point read. */
export async function exactChildTally(
  db: QueryCtx['db'],
  partition: Id<'projectWorkGenerations'>,
  parentId: string,
  counts?: PlanCounts,
) {
  if (!counts) {
    const row = await planCounter(db, partition);
    if (!row) return null;
    counts = JSON.parse(row.value) as PlanCounts;
  }
  return readRollupScope(
    db,
    partition,
    `parent:${parentId}`,
    counts.scopeThrough === null && !counts.scopeBlocked,
  );
}

/** An empty map entry means zero only when every counted Issue kept its Initiative membership. */
export async function coveredInitiativeTallies(db: QueryCtx['db'], partition: Id<'projectWorkGenerations'>) {
  const row = await planCounter(db, partition);
  const stored = row ? (JSON.parse(row.value) as PlanCounts) : null;
  if (!stored?.done || stored.v !== 2 || stored.g?.h?.some(Boolean) || stored.x?.some(Boolean)) return null;
  const byInitiative = new Map<string, Tally>();
  for (const [group, tally] of Object.entries(stored.g ?? {})) {
    const [id] = group.split('|', 1);
    if (!id) continue;
    let counts = byInitiative.get(id);
    if (!counts) byInitiative.set(id, (counts = zeroTally()));
    PLAN_STATUSES.forEach((status, index) => (counts[status] += tally[index] ?? 0));
  }
  return byInitiative;
}

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
  value: JSON.stringify({ ...emptyPlanCounts(true), scopeThrough: null }),
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
  type Deltas = Map<RollupScope, RollupCounts>;
  const changes = new Map<
    Id<'projectWorkGenerations'>,
    {
      projectId: Id<'hostedProjects'>;
      totals: Change[];
      scoped: {
        key: string;
        changes: Deltas | null;
        before?: ScopeMember | null;
        after?: ScopeMember | null;
      }[];
    }
  >();
  const header = new Map<Id<'projectWorkGenerations'>, ReturnType<typeof planCounter>>();
  const getHeader = (partition: Id<'projectWorkGenerations'>) => {
    const row = header.get(partition) ?? planCounter(db, partition);
    header.set(partition, row);
    return row;
  };
  const scopes = rollupScopeReads(db);
  return {
    /** Earlier writes in the same mutation have changed their roots, but their tallies haven't flushed. */
    async children(partition: Id<'projectWorkGenerations'>, parentId: string) {
      const row = await getHeader(partition);
      const counts = row ? (JSON.parse(row.value) as PlanCounts) : null;
      if (counts?.scopeThrough !== null || counts.scopeBlocked) return null;
      const pending = changes.get(partition)?.scoped ?? [];
      if (pending.some(change => !change.changes)) return null;
      const key = `parent:${parentId}` as const;
      const total = { ...(await scopes.read(partition, key)).counts };
      for (const change of pending) {
        const delta = change.changes?.get(key);
        if (delta) addRollupCounts(total, delta);
      }
      return total.total >= 0 ? total.total : null;
    },
    change(before: Root | null, after: Root | null) {
      const was = planRootFacts(before),
        now = planRootFacts(after);
      const scopeDeltas = rollupMembershipChanges(was?.member ?? null, now?.member ?? null);
      const badScope = (was?.kind === 'issue' && !was.member) || (now?.kind === 'issue' && !now.member);
      const entriesFor = (root: Root) => {
        let entries = changes.get(root.generationId);
        if (!entries)
          changes.set(root.generationId, (entries = { projectId: root.projectId, totals: [], scoped: [] }));
        return entries;
      };
      if (scopeDeltas.size || badScope) {
        const root = (after ?? before)!;
        const linked = Boolean(before && scopeDeltas.size);
        entriesFor(root).scoped.push({
          key: root.key!,
          changes: badScope ? null : scopeDeltas,
          ...(linked ? { before: was?.member ?? null, after: now?.member ?? null } : {}),
        });
      }
      if (was && now && was.kind === now.kind && was.status === now.status && was.group === now.group) return;
      if (was) entriesFor(before!).totals.push({ ...was, sign: -1, closing: false });
      if (now)
        entriesFor(after!).totals.push({
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
      for (const [partition, { projectId, totals, scoped }] of changes) {
        const row = await getHeader(partition);
        if (!row) continue;
        const counts = JSON.parse(row.value) as PlanCounts;
        if (scoped.length && counts.scopeThrough !== undefined && !counts.scopeBlocked) {
          const deltas: Deltas = new Map();
          const effective: Deltas = new Map();
          const collect = (target: Deltas, changes: Deltas) => {
            for (const [scope, move] of changes) {
              let delta = target.get(scope);
              if (!delta) target.set(scope, (delta = emptyRollupCounts()));
              addRollupCounts(delta, move);
            }
          };
          for (const { key, changes: moves, before, after } of scoped) {
            if (counts.scopeThrough !== null && key > counts.scopeThrough) continue;
            if (!moves) {
              counts.scopeBlocked = true;
              break;
            }
            let adjusted = moves;
            if (before || after) {
              const { forwarded } = await scopes.read(partition, `parent:${key}`);
              if (forwarded)
                adjusted = rollupMembershipChanges(before ?? null, after ?? null, forwarded, forwarded);
            }
            collect(deltas, moves);
            collect(effective, adjusted);
          }
          if (
            !counts.scopeBlocked &&
            !(await applyRollupDeltas(db, { projectId, partition }, deltas, effective, key =>
              scopes.read(partition, key),
            ))
          )
            counts.scopeBlocked = true;
        }
        if (!totals.length && !counts.scopeBlocked) continue;
        const today = utcDay(Date.now());
        if (totals.length && counts.day !== today) Object.assign(counts, { day: today, closedToday: 0 });
        for (const change of totals) {
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
      header.clear();
      scopes.clear();
    },
  };
}
