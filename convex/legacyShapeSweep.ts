// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation } from './server';
import { internalQuery } from './_generated/server';
import { invariant } from '../src/errors';
import { readHostedRecord } from './projectHostedRecords';
import { readArchiveCoverage, saveArchiveCoverage } from './projectPlanningArchiveCoverage';
import { metricReadProjection } from './projectMetricReadProjection';

/** One-off converter for Item c0af6cfa, small-shape sweep (families F9 probe, F10, F11, F12 non-secret).
 * Every step is idempotent on the row's own state, so a replay reads the same pages and writes 0:
 *  - F11 `projects`: unsets the retired fields `r2StorageUsed`, `r2Writes`, `stateTrees`; a legacy
 *    `planningArchiveIndexed` marker moves into the coverage receipt (the write `saveArchiveCoverage`
 *    already makes on first use). A project blocked by the retired `R2_MAINTENANCE_DISABLED` purge
 *    switch is only reported: its removal needs the owner's `retry`.
 *  - F11 `imports`: unsets `remote`, `workerClaimed`, `r2Writes`. `users`: unsets `legacyGithubProvider`,
 *    `legacyPasskeyFlow`. `objects`: unsets `stateTree` (a full scan of `projectObjects`, so opt-in).
 *  - F12 `teamMembers`: sets the missing `handle` (the one-time backfill of convex/teamHandles.ts).
 *  - F10 `overlapLanes`: stamps `lastActivityAt` once. An open row takes its Lane record's `at` (what the
 *    landing-completion healer stamped, 5 rows per landing); a row whose Lane record is gone is closed;
 *    a closed row takes its presence time, else its creation time (no read).
 * Read-only probes: `metricsProbe` (check runs not yet projected, per project) and `reportsEdge` (where
 * check runs moved from inline reports to R2 reports). Dev ran it before the readers were deleted; prod
 * runs it from the pinned in-between release (P8 runbook docs/operations/legacy-small-shapes.md). */
export const FAMILIES = ['projects', 'imports', 'users', 'teamMembers', 'overlapLanes', 'objects'] as const;
type Family = (typeof FAMILIES)[number];
const family = v.union(...FAMILIES.map(name => v.literal(name)));
const PAGE_ROWS = 100;
const PAGE_BYTES = 1024 * 1024;
/** What one page may read beyond its scan: the page cap above plus the lookups a conversion adds (project and
 * Lane record per open overlap row, one account per member, one receipt per project). The budget check
 * reserves this much before every page. */
const PAGE_RESERVE = 2 * PAGE_BYTES;
/** An overlap page converts open rows with two lookups each, so it is smaller. */
const OVERLAP_PAGE_ROWS = 20;
const OBJECT_PAGE_ROWS = 256;
const BLOCKED_DETAIL = 20;

const pageResult = v.object({
  cursor: v.union(v.string(), v.null()),
  scanned: v.number(),
  counts: v.record(v.string(), v.number()),
  changed: v.number(),
  readBytes: v.number(),
  blockedIds: v.array(v.string()),
});
type PageResult = typeof pageResult.type;

/** Strip `fields` from a row, counting each one present. */
function strip(
  row: Record<string, unknown>,
  fields: readonly string[],
  table: string,
  counts: Record<string, number>,
) {
  const patch: Record<string, undefined> = {};
  for (const field of fields)
    if (row[field] !== undefined) {
      patch[field] = undefined;
      counts[`${table}.${field}`] = (counts[`${table}.${field}`] ?? 0) + 1;
    }
  return Object.keys(patch).length ? patch : null;
}

/** One bounded page of one family, `apply:false` reads only. */
export const page = internalMutation({
  args: { family, cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: pageResult,
  handler: async (ctx, { family: name, cursor, apply }): Promise<PageResult> => {
    const counts: Record<string, number> = {};
    const out = { scanned: 0, changed: 0, readBytes: 0, blockedIds: [] as string[] };
    const finish = (next: string | null): PageResult => ({ ...out, counts, cursor: next });
    const options = (rows: number) => ({ cursor, numItems: rows, maximumBytesRead: PAGE_BYTES });
    const note = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
    if (name === 'projects') {
      const rows = await ctx.db
        .query('hostedProjects')
        .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
        .paginate(options(PAGE_ROWS));
      for (const row of rows.page) {
        out.scanned++;
        out.readBytes += getDocumentSize(row);
        const patch = strip(row, ['r2StorageUsed', 'r2Writes', 'stateTrees'], 'hostedProjects', counts);
        if (patch) {
          out.changed++;
          if (apply) await ctx.db.patch(row._id, patch);
        }
        if (row.planningArchiveIndexed !== undefined) {
          note('hostedProjects.planningArchiveIndexed');
          out.changed++;
          if (apply) {
            const { row: receipt, state } = await readArchiveCoverage(ctx, row);
            if (receipt) out.readBytes += getDocumentSize(receipt);
            await saveArchiveCoverage(ctx, row, receipt, state);
          }
        }
        if (row.purgeBlocked === 'R2_MAINTENANCE_DISABLED') {
          note('hostedProjects.purgeBlocked:R2_MAINTENANCE_DISABLED');
          if (out.blockedIds.length < BLOCKED_DETAIL) out.blockedIds.push(row._id);
        }
      }
      return finish(rows.isDone ? null : rows.continueCursor);
    }
    if (name === 'imports') {
      const rows = await ctx.db
        .query('imports')
        .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
        .paginate(options(PAGE_ROWS));
      for (const row of rows.page) {
        out.scanned++;
        out.readBytes += getDocumentSize(row);
        const patch = strip(row, ['remote', 'workerClaimed', 'r2Writes'], 'imports', counts);
        if (patch) {
          out.changed++;
          if (apply) await ctx.db.patch(row._id, patch);
        }
      }
      return finish(rows.isDone ? null : rows.continueCursor);
    }
    if (name === 'users') {
      const rows = await ctx.db
        .query('users')
        .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
        .paginate(options(PAGE_ROWS));
      for (const row of rows.page) {
        out.scanned++;
        out.readBytes += getDocumentSize(row);
        const patch = strip(row, ['legacyGithubProvider', 'legacyPasskeyFlow'], 'users', counts);
        if (patch) {
          out.changed++;
          if (apply) await ctx.db.patch(row._id, patch);
        }
      }
      return finish(rows.isDone ? null : rows.continueCursor);
    }
    if (name === 'objects') {
      const rows = await ctx.db
        .query('projectObjects')
        .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
        .paginate(options(OBJECT_PAGE_ROWS));
      for (const row of rows.page) {
        out.scanned++;
        out.readBytes += getDocumentSize(row);
        const patch = strip(row, ['stateTree'], 'projectObjects', counts);
        if (patch) {
          out.changed++;
          if (apply) await ctx.db.patch(row._id, patch);
        }
      }
      return finish(rows.isDone ? null : rows.continueCursor);
    }
    if (name === 'teamMembers') {
      const rows = await ctx.db
        .query('teamMembers')
        .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
        .paginate(options(PAGE_ROWS));
      for (const row of rows.page) {
        out.scanned++;
        out.readBytes += getDocumentSize(row);
        if (row.handle !== undefined) continue;
        note('teamMembers.handle');
        // The lookup of convex/teamHandles.ts#memberHandle, with its bytes counted.
        const account = await ctx.db
          .query('forgeAccounts')
          .withIndex('by_owner', q => q.eq('owner', row.member))
          .unique();
        if (account) out.readBytes += getDocumentSize(account);
        out.changed++;
        if (apply) await ctx.db.patch(row._id, { handle: account?.handle ?? null });
      }
      return finish(rows.isDone ? null : rows.continueCursor);
    }
    // overlapLanes: an open row costs one project read (cached per page) and one Lane record read.
    const rows = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
      .paginate(options(OVERLAP_PAGE_ROWS));
    const owners = new Map<string, Doc<'hostedProjects'> | null>();
    for (const row of rows.page) {
      out.scanned++;
      out.readBytes += getDocumentSize(row);
      if (row.lastActivityAt !== undefined) continue;
      note(row.open ? 'overlapLanes.lastActivityAt:open' : 'overlapLanes.lastActivityAt:closed');
      const quiet = row.presenceRow?.at ?? row._creationTime;
      if (!row.open) {
        out.changed++;
        if (apply) await ctx.db.patch(row._id, { lastActivityAt: quiet });
        continue;
      }
      if (!owners.has(row.projectId)) {
        const found = await ctx.db.get(row.projectId);
        if (found) out.readBytes += getDocumentSize(found);
        owners.set(row.projectId, found);
      }
      const project = owners.get(row.projectId) ?? null;
      const record = project
        ? await readHostedRecord(ctx, {
            projectId: project._id,
            actor: project.owner,
            kind: 'lane',
            key: row.laneId,
          })
        : null;
      if (record) out.readBytes += getDocumentSize(record);
      let at = NaN;
      try {
        at = record ? Date.parse((JSON.parse(record.value) as { at?: string }).at ?? '') : NaN;
      } catch {
        // An unreadable body still has its version's own write time below.
      }
      if (record && !Number.isFinite(at)) at = record._creationTime;
      out.changed++;
      if (apply)
        await ctx.db.patch(row._id, record ? { lastActivityAt: at } : { open: false, lastActivityAt: quiet });
      if (!record) note('overlapLanes.closedNoRecord');
    }
    return finish(rows.isDone ? null : rows.continueCursor);
  },
});

const familyTotal = v.object({
  family,
  pages: v.number(),
  scanned: v.number(),
  changed: v.number(),
  counts: v.record(v.string(), v.number()),
  readBytes: v.number(),
  blockedIds: v.array(v.string()),
  stopped: v.union(v.null(), v.literal('budget')),
  cursor: v.union(v.string(), v.null()),
});

/** Operator entry point: `apply:false` is the dry run and writes nothing. The read budget is a hard
 * stop checked before every page (a page reserves PAGE_RESERVE, 2 MiB, for its scan and lookups), so a run stops at
 * `budgetBytes` minus that reserve and reports its cursor; `from` continues it. `objects` is a full scan of
 * `projectObjects` and runs only when named in `families`. */
export const run = internalAction({
  args: {
    apply: v.boolean(),
    budgetBytes: v.number(),
    families: v.optional(v.array(family)),
    from: v.optional(v.object({ family, cursor: v.string() })),
  },
  returns: v.object({ totals: v.array(familyTotal), readBytes: v.number() }),
  handler: async (ctx, { apply, budgetBytes, families, from }) => {
    const names: readonly Family[] = families ?? FAMILIES.filter(name => name !== 'objects');
    invariant(
      budgetBytes > 0 && budgetBytes <= 400_000_000,
      'BAD_ARGUMENT',
      'State a read budget of at most 400 MB.',
    );
    const totals: (typeof familyTotal.type)[] = [];
    let readBytes = 0;
    for (const name of names) {
      const total: typeof familyTotal.type = {
        family: name,
        pages: 0,
        scanned: 0,
        changed: 0,
        counts: {},
        readBytes: 0,
        blockedIds: [],
        stopped: null,
        cursor: null,
      };
      let cursor: string | null = from?.family === name ? from.cursor : null;
      do {
        if (readBytes + PAGE_RESERVE > budgetBytes) {
          total.stopped = 'budget';
          total.cursor = cursor;
          break;
        }
        const next: PageResult = await ctx.runMutation(internal.legacyShapeSweep.page, {
          family: name,
          cursor,
          apply,
        });
        total.pages++;
        total.scanned += next.scanned;
        total.changed += next.changed;
        total.readBytes += next.readBytes;
        readBytes += next.readBytes;
        for (const [key, count] of Object.entries(next.counts))
          total.counts[key] = (total.counts[key] ?? 0) + count;
        for (const id of next.blockedIds)
          if (total.blockedIds.length < BLOCKED_DETAIL) total.blockedIds.push(id);
        cursor = next.cursor;
      } while (cursor !== null);
      totals.push(total);
    }
    return { totals, readBytes };
  },
});

const PROBE_RUNS = 10;
const PROBE_PROJECTS = 10;
/** One query reads at most this many bytes of run rows before it hands back a continuation. */
const PROBE_BYTES = 8 * 1024 * 1024;
/** A run whose report lives in its row's `value` (or detached parts) instead of R2: the R2 writer is
 * off for the run, and the provider is not `ci-status`, whose runs never carry reports at all. */
function inlineReport(row: Doc<'projectHostedCheckRuns'>) {
  if (row.reportStorage === 'r2') return false;
  try {
    return (
      (JSON.parse(row.value) as { configuration?: { provider?: string } }).configuration?.provider !==
      'ci-status'
    );
  } catch {
    return true;
  }
}
const probeProject = v.object({
  project: v.string(),
  unprojected: v.number(),
  capped: v.boolean(),
  bytes: v.number(),
  unprojectable: v.number(),
  statuses: v.record(v.string(), v.number()),
  oldestAgeHours: v.number(),
  newestAgeHours: v.number(),
  oldestRunInline: v.union(v.boolean(), v.null()),
  newestRunInline: v.union(v.boolean(), v.null()),
});
/** Read-only (F9). Per project with check runs: runs whose metric projection is absent (`metricsProjected`
 * unset), up to PROBE_RUNS of them, with their statuses, ages and whether the compact projection can be
 * built from them; and whether the oldest and newest run hold an inline report. A page is PROBE_PROJECTS
 * projects and stops early at PROBE_BYTES of run rows: the reply then names `resume` (the same cursor and
 * how many of its projects are done), which the next call passes back. A project with no runs reads one
 * empty index range. */
export const metricsProbe = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), skip: v.optional(v.number()) },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    resume: v.union(v.null(), v.object({ cursor: v.union(v.string(), v.null()), skip: v.number() })),
    readBytes: v.number(),
    projects: v.array(probeProject),
  }),
  handler: async (ctx, { cursor, skip = 0 }) => {
    const projects = await ctx.db
      .query('hostedProjects')
      .withIndex('by_creation_time', q => q.gte('_creationTime', 0))
      .paginate({ cursor, numItems: PROBE_PROJECTS, maximumBytesRead: PAGE_BYTES });
    const now = Date.now();
    let readBytes = projects.page.reduce((sum, row) => sum + getDocumentSize(row), 0);
    const found: (typeof probeProject.type)[] = [];
    let done = skip;
    for (const project of projects.page.slice(skip)) {
      if (readBytes > PROBE_BYTES) break;
      done++;
      const runs = () =>
        ctx.db.query('projectHostedCheckRuns').withIndex('by_project', q => q.eq('projectId', project._id));
      const [first] = await runs().take(1);
      if (!first) continue;
      const [last] = await runs().order('desc').take(1);
      const rows = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_metrics_projection', q =>
          q.eq('projectId', project._id).eq('metricsProjected', undefined),
        )
        .take(PROBE_RUNS + 1);
      const statuses: Record<string, number> = {};
      let bytes = 0,
        unprojectable = 0,
        oldest = Infinity,
        newest = 0;
      for (const row of rows.slice(0, PROBE_RUNS)) {
        bytes += getDocumentSize(row);
        statuses[row.status] = (statuses[row.status] ?? 0) + 1;
        if (!metricReadProjection(row as unknown as Record<string, unknown>)) unprojectable++;
        oldest = Math.min(oldest, row._creationTime);
        newest = Math.max(newest, row._creationTime);
      }
      readBytes +=
        bytes + getDocumentSize(first) + (last && last._id !== first._id ? getDocumentSize(last) : 0);
      found.push({
        project: project._id,
        unprojected: Math.min(rows.length, PROBE_RUNS),
        capped: rows.length > PROBE_RUNS,
        bytes,
        unprojectable,
        statuses,
        oldestAgeHours: rows.length ? Math.round((now - oldest) / 3_600_000) : 0,
        newestAgeHours: rows.length ? Math.round((now - newest) / 3_600_000) : 0,
        oldestRunInline: inlineReport(first),
        newestRunInline: last ? inlineReport(last) : null,
      });
    }
    return {
      cursor: projects.isDone ? null : projects.continueCursor,
      resume: done < projects.page.length ? { cursor, skip: done } : null,
      readBytes,
      projects: found,
    };
  },
});

/** Read-only (F9 inline reports). Searches one project's check runs by creation time for where inline reports
 * stop, assuming the R2 writer switched on once. Every step narrows the interval: a run at or after the
 * midpoint that is inline raises `inlineAtOrAfter` to that run, an R2 run lowers `r2Before` to the midpoint. The
 * newest inline run lies in `[inlineAtOrAfter, r2Before)`; `resolved` is true once that interval is one
 * millisecond wide. An unresolved bracket still bounds the cutoff from above by `r2Before`, which is the
 * date a removal line must use. Reads at most `steps` one-row lookups after the first and last run. */
export const reportsEdge = internalQuery({
  args: { projectId: v.id('hostedProjects'), steps: v.number() },
  returns: v.object({
    inlineAtOrAfter: v.union(v.number(), v.null()),
    r2Before: v.union(v.number(), v.null()),
    resolved: v.boolean(),
    lastRunInline: v.boolean(),
    probes: v.number(),
    readBytes: v.number(),
  }),
  handler: async (ctx, { projectId, steps }) => {
    invariant(steps >= 1 && steps <= 40, 'BAD_ARGUMENT', 'Use 1 to 40 steps.');
    const runs = () =>
      ctx.db.query('projectHostedCheckRuns').withIndex('by_project', q => q.eq('projectId', projectId));
    const [first] = await runs().take(1);
    const [last] = await runs().order('desc').take(1);
    const none = {
      inlineAtOrAfter: null,
      r2Before: null,
      resolved: true,
      lastRunInline: false,
      probes: 0,
      readBytes: 0,
    };
    if (!first || !last) return none;
    let readBytes = getDocumentSize(first) + getDocumentSize(last),
      probes = 2;
    // The newest run is still inline: no cutoff yet.
    if (inlineReport(last))
      return {
        ...none,
        inlineAtOrAfter: last._creationTime,
        resolved: false,
        lastRunInline: true,
        probes,
        readBytes,
      };
    // The oldest run is already R2: nothing inline ever existed.
    if (!inlineReport(first)) return { ...none, r2Before: first._creationTime, probes, readBytes };
    let lo = first._creationTime,
      hi = last._creationTime;
    for (let i = 0; i < steps && hi - lo > 1; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const [row] = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project', q => q.eq('projectId', projectId).gte('_creationTime', mid))
        .take(1);
      probes++;
      if (!row) {
        hi = mid;
        continue;
      }
      readBytes += getDocumentSize(row);
      if (inlineReport(row)) lo = row._creationTime;
      else hi = mid;
    }
    return {
      inlineAtOrAfter: lo,
      r2Before: hi,
      resolved: hi - lo <= 1,
      lastRunInline: false,
      probes,
      readBytes,
    };
  },
});
