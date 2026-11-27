// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { isShelved } from '../src/work-planning-types';
import { planningStatusTransition } from '../src/work-planning-state';
import { hostedRecordBody } from './projectHostedRecords';
import { instant, planningTime, type PlanningTimesRead } from './projectPlanningTimes';

export { instant } from './projectPlanningTimes';

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

export const planningHistoryResult = v.object({
  closedByDay: v.array(v.object({ day: v.string(), count: v.number() })),
  coverage: v.union(v.literal('complete'), v.literal('partial'), v.literal('unavailable')),
  unresolved: v.number(),
});

export function planningHistoryBudget(byteLimit = pageBytes, maxVersions = perItemVersions) {
  let bytes = byteLimit;
  const spend = (size: number) => {
    bytes -= size;
    return bytes >= 0;
  };
  return {
    get exhausted() {
      return bytes <= 0;
    },
    get readBytes() {
      return byteLimit - bytes;
    },
    maxVersions,
    record: (row: Parameters<typeof getDocumentSize>[0]) => spend(getDocumentSize(row)),
    spend,
  };
}

export async function recordSnapshot(
  ctx: QueryCtx,
  row: IssueRecord,
  charge: ReturnType<typeof planningHistoryBudget>,
): Promise<Snapshot | null> {
  if (charge.exhausted) return null;
  if (row.inline === undefined && !charge.spend(row.bytes)) return null;
  return JSON.parse(await hostedRecordBody(ctx, row)).item;
}

async function* earlierVersions(
  ctx: QueryCtx,
  project: Project,
  item: Snapshot,
  charge: ReturnType<typeof planningHistoryBudget>,
): AsyncGenerator<VersionRead> {
  const through = item.at === undefined ? item.version : item.version - 1;
  if (charge.exhausted || through < 1) return;
  const rows = ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q.eq('projectId', project._id).eq('kind', 'issue').eq('key', item.id).lte('version', through),
    )
    .order('desc');
  for await (const row of rows) {
    if (!charge.record(row) || row.purged) break;
    yield { ...row, snapshot: () => recordSnapshot(ctx, row, charge) };
  }
}

// A return to Closed from a shelf preserves the earlier close. A shelved version whose former status
// is missing cannot prove whether this is a restore or a new close.
export async function restoredClosed(previous: VersionRead) {
  if (!isShelved(previous.status)) return false;
  const was = (await previous.snapshot())?.was;
  return was === undefined ? null : was === 'closed';
}

async function itemTimes(item: Snapshot, history: AsyncIterable<VersionRead>, maxVersions: number) {
  const seekClose = item.status === 'closed';
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
        if (!seekClose) break;
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
    if (version.version === 1 || ++read >= maxVersions) break;
  }
  if (version.version === 1) {
    statusChange ??= version;
    if (seekClose && version.status === 'closed') close ??= version;
  }
  const timestamp = async (read: VersionRead | undefined) => planningTime((await read?.snapshot())?.at);
  const lastStatusChangeAt = await timestamp(statusChange);
  return {
    lastStatusChangeAt,
    closeKept: close === statusChange ? lastStatusChangeAt : await timestamp(close),
  };
}

/** One code-chosen label per authorized record-store list/detail query. DEV forwards query
 * logs to clients, so this must never include an Item id or any data from the request or head. */
export function planningTimesFallbackReporter() {
  let noted = false;
  return (reason: 'missing' | 'stale') => {
    if (noted) return;
    noted = true;
    console.log(`FORGE_IO_ATTRIBUTION ${JSON.stringify({ label: `planning/history-fallback-${reason}` })}`);
  };
}

export async function withPlanningTimes(
  ctx: QueryCtx,
  project: Project,
  value: string,
  charge: ReturnType<typeof planningHistoryBudget>,
  pinned?: PlanningTimesRead,
  reportFallback?: ReturnType<typeof planningTimesFallbackReporter>,
) {
  const item = JSON.parse(value) as Snapshot;
  if (item.purged) return JSON.stringify({ ...item, lastStatusChangeAt: null, closedAt: null });
  if (pinned && pinned !== 'stale' && pinned.version === item.version)
    return JSON.stringify({
      ...item,
      lastStatusChangeAt: pinned.lastStatusChangeAt,
      closedAt: pinned.closedAt,
    });
  reportFallback?.(pinned ? 'stale' : 'missing');
  const { lastStatusChangeAt, closeKept } = await itemTimes(
    item,
    earlierVersions(ctx, project, item, charge),
    charge.maxVersions,
  );
  return JSON.stringify({
    ...item,
    lastStatusChangeAt,
    closedAt: item.status === 'closed' ? closeKept : null,
  });
}

/** The Initiative on the immutable version is its group at the time of the close. The range uses
 * insertion time only to select candidates (a copied old version can be newer); the journal's
 * own timestamp places a proved transition in its UTC bucket. */
export async function initiativeCloseHistory(
  ctx: QueryCtx,
  project: Project,
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
          return header && (outside || charge.record(header)) ? recordSnapshot(ctx, header, charge) : null;
        },
      });
      if (restored === null) unresolved++;
      if (restored !== false) continue;
    }
    const item = await recordSnapshot(ctx, row, charge);
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
