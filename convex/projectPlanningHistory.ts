// SPDX-License-Identifier: Apache-2.0
import { getDocumentSize, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { isShelved } from '../src/work-planning-types';
import { planningStatusTransition } from '../src/work-planning-state';
import { hostedRecordBody } from './projectHostedRecords';

type Version = {
  version: number;
  status: string;
};
type Snapshot = Version & {
  id: string;
  at?: string;
  kind: 'issue' | 'initiative';
  purged?: unknown;
  was?: string;
};
type VersionRead = Version & { snapshot: () => Promise<Snapshot | null> };
type IssueRecord = Doc<'projectHostedRecords'>;
type Project = Doc<'hostedProjects'>;

const dayMs = 86_400_000;
const perItemVersions = 32;
const recentVersions = 4096;
const recentCloses = 512;
const initiativeWindowBytes = 8 * 1024 * 1024;
const pageBytes = 2 * 1024 * 1024;

// Journal writes use UTC ISO timestamps. Require an exact calendar date so permissive
// Date.parse normalization cannot turn retained malformed text into dated evidence.
export function instant(at: string | undefined) {
  if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)) return NaN;
  const time = Date.parse(at);
  return Number.isFinite(time) &&
    new Date(time).toISOString() === (at.includes('.') ? at : at.replace('Z', '.000Z'))
    ? time
    : NaN;
}

export const planningHistoryResult = v.object({
  closedByDay: v.array(v.object({ day: v.string(), count: v.number() })),
  coverage: v.union(v.literal('complete'), v.literal('partial'), v.literal('unavailable')),
  unresolved: v.number(),
});

export function planningHistoryBudget(byteLimit = pageBytes) {
  let bytes = byteLimit;
  const spend = (size: number) => {
    bytes -= size;
    return bytes >= 0;
  };
  return {
    get exhausted() {
      return bytes <= 0;
    },
    record: (row: Parameters<typeof getDocumentSize>[0]) => spend(getDocumentSize(row)),
    spend,
  };
}

export function legacyVersions(ctx: QueryCtx, partition: Id<'projectWorkGenerations'>, itemId: string) {
  return ctx.db
    .query('projectPlanningRecords')
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q.eq('generationId', partition).eq('collection', 'planningVersions').eq('parent', itemId),
    )
    .order('desc');
}

export async function recordSnapshot(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  row: IssueRecord,
  charge: ReturnType<typeof planningHistoryBudget>,
): Promise<Snapshot | null> {
  if (charge.exhausted) return null;
  if (row.journalSegment) {
    // Earlier journal policies could move Item bodies to R2. The journal's exact legacy version
    // remains usable where retained; otherwise leave this time unproved within the page budget.
    let read = 0;
    for await (const legacy of legacyVersions(ctx, partition, row.key)) {
      if (read++ >= perItemVersions || !charge.record(legacy)) break;
      const snapshot = JSON.parse(legacy.value) as Snapshot;
      if (snapshot.version === row.version && !snapshot.purged) return snapshot;
      if (snapshot.version < row.version) break;
    }
    return null;
  }
  if (row.inline === undefined && !charge.spend(row.bytes)) return null;
  return JSON.parse(await hostedRecordBody(ctx, row)).item;
}

async function* earlierVersions(
  ctx: QueryCtx,
  project: Project,
  partition: Id<'projectWorkGenerations'>,
  item: Snapshot,
  charge: ReturnType<typeof planningHistoryBudget>,
): AsyncGenerator<VersionRead> {
  const through = item.at === undefined ? item.version : item.version - 1;
  if (charge.exhausted || through < 1) return;
  if (project.workStore === 'records') {
    const rows = ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
        q.eq('projectId', project._id).eq('kind', 'issue').eq('key', item.id).lte('version', through),
      )
      .order('desc');
    for await (const row of rows) {
      if (!charge.record(row) || row.purged) break;
      yield { ...row, snapshot: () => recordSnapshot(ctx, partition, row, charge) };
    }
    return;
  }
  for await (const row of legacyVersions(ctx, partition, item.id)) {
    if (!charge.record(row)) break;
    const previous = JSON.parse(row.value) as Snapshot;
    if (previous.version > through) continue;
    if (previous.purged) break;
    yield { ...previous, snapshot: async () => previous };
  }
}

// A return to Closed from a shelf preserves the earlier close. A shelved version whose former status
// is missing cannot prove whether this is a restore or a new close.
export async function restoredClosed(previous: VersionRead) {
  if (!isShelved(previous.status)) return false;
  const was = (await previous.snapshot())?.was;
  return was === undefined ? null : was === 'closed';
}

async function itemTimes(item: Snapshot, history: AsyncIterable<VersionRead>) {
  let version: VersionRead = { ...item, snapshot: async () => item };
  let statusChange: VersionRead | undefined;
  let close: VersionRead | undefined;
  let read = 0;
  for await (const previous of history) {
    // Ranked search previews carry a version and status, but need the canonical timestamp.
    if (previous.version === item.version) {
      if (previous.status !== item.status) break;
    } else {
      const changed = planningStatusTransition(version, previous);
      if (changed === null) break;
      if (changed) {
        statusChange ??= version;
        if (item.status !== 'closed') break;
        if (version.status === 'closed') {
          const restored = await restoredClosed(previous);
          if (restored === null) break;
          if (!restored) {
            close = version;
            break;
          }
        }
      }
    }
    version = previous;
    if (version.version === 1 || ++read >= perItemVersions) break;
  }
  if (version.version === 1) {
    statusChange ??= version;
    if (item.status === 'closed' && version.status === 'closed') close ??= version;
  }
  const timestamp = async (read: VersionRead | undefined) => {
    const at = (await read?.snapshot())?.at;
    return at && Number.isFinite(instant(at)) ? at : null;
  };
  const lastStatusChangeAt = await timestamp(statusChange);
  return {
    lastStatusChangeAt,
    closedAt: close === statusChange ? lastStatusChangeAt : await timestamp(close),
  };
}

export async function withPlanningTimes(
  ctx: QueryCtx,
  project: Project,
  partition: Id<'projectWorkGenerations'>,
  value: string,
  charge: ReturnType<typeof planningHistoryBudget>,
) {
  const item = JSON.parse(value) as Snapshot;
  const times = item.purged
    ? { lastStatusChangeAt: null, closedAt: null }
    : await itemTimes(item, earlierVersions(ctx, project, partition, item, charge));
  return JSON.stringify({ ...item, ...times });
}

/** The Initiative on the immutable version is its group at the time of the close. The range uses
 * insertion time only to select candidates (a copied old version can be newer); the journal's
 * own timestamp places a proved transition in its UTC bucket. */
export async function initiativeCloseHistory(
  ctx: QueryCtx,
  project: Project,
  partition: Id<'projectWorkGenerations'>,
  initiativeId: string,
  now: number,
  day?: number,
) {
  const today = Math.floor(now / dayMs);
  // Keep the read on the day that the CLI opened it across a midnight boundary.
  const selectedDay = day === today - 1 ? day : today;
  const start = (selectedDay - 13) * dayMs;
  const end = Math.min(now, (selectedDay + 1) * dayMs - 1);
  const closedByDay = Array.from({ length: 14 }, (_, i) => ({
    day: new Date(start + i * dayMs).toISOString().slice(0, 10),
    count: 0,
  }));
  if (project.workStore !== 'records')
    return { closedByDay: [], coverage: 'unavailable' as const, unresolved: 0 };
  const selectionBudget = planningHistoryBudget(initiativeWindowBytes);
  const charge = planningHistoryBudget();
  const purgedItems = new Set(
    project.itemPurges?.flatMap(({ itemId, commentId }) => (commentId ? [] : [itemId])),
  );
  const window = new Map<string, Version & { purged?: string; shelfId?: Id<'projectHostedRecords'> }>();
  const candidates: IssueRecord[] = [];
  const rows = ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_parent', q =>
      q
        .eq('projectId', project._id)
        .eq('kind', 'issue')
        .eq('parent', initiativeId)
        .gte('_creationTime', start),
    );
  let truncated = false;
  let scanned = 0;
  for await (const row of rows) {
    if (scanned++ >= recentVersions || !selectionBudget.record(row)) {
      truncated = true;
      break;
    }
    window.set(`${row.key}:${row.version}`, {
      version: row.version,
      status: row.status,
      ...(row.purged ? { purged: row.purged } : {}),
      ...(isShelved(row.status) ? { shelfId: row._id } : {}),
    });
    if (row.status !== 'closed' || row.purged || purgedItems.has(row.key)) continue;
    if (candidates.length >= recentCloses) {
      truncated = true;
      break;
    }
    candidates.push(row);
  }
  let unresolved = 0;
  for (const row of candidates) {
    if (charge.exhausted) {
      unresolved++;
      continue;
    }
    const inWindow = window.get(`${row.key}:${row.version - 1}`);
    // A predecessor can predate the window or belong to another Initiative. Reuse the scoped page
    // for the common case, and prove those misses by exact version in the same transaction.
    const outside =
      inWindow || row.version <= 1
        ? null
        : await ctx.db
            .query('projectHostedRecords')
            .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
              q
                .eq('projectId', project._id)
                .eq('kind', 'issue')
                .eq('key', row.key)
                .eq('version', row.version - 1)
                .eq('lifecyclePlanId', undefined),
            )
            .unique();
    if (outside && !charge.record(outside)) {
      unresolved++;
      continue;
    }
    const previous = inWindow ?? outside ?? undefined;
    const changed = planningStatusTransition(row, previous?.purged ? undefined : previous);
    if (changed === false) continue;
    if (changed === null) {
      unresolved++;
      continue;
    }
    if (previous && isShelved(previous.status)) {
      const restored = await restoredClosed({
        ...previous,
        snapshot: async () => {
          const id = inWindow?.shelfId;
          const header = outside ?? (id ? await ctx.db.get(id) : null);
          return header && (outside || charge.record(header))
            ? recordSnapshot(ctx, partition, header, charge)
            : null;
        },
      });
      if (restored === null) unresolved++;
      if (restored !== false) continue;
    }
    const item = await recordSnapshot(ctx, partition, row, charge);
    const at = instant(item?.at);
    if (!Number.isFinite(at)) unresolved++;
    else if (item?.kind === 'issue' && at >= start && at <= end)
      closedByDay[Math.floor((at - start) / dayMs)]!.count++;
  }
  return {
    closedByDay,
    coverage: truncated || unresolved ? ('partial' as const) : ('complete' as const),
    unresolved,
  };
}
