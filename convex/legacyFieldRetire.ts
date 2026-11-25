// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation } from './server';
import type { Doc } from './_generated/dataModel';

/** One-off converter for Item c0af6cfa (F6 leftovers). It clears the R2 backfill markers, turns a
 * leftover `location:'convex'` into `'r2'` when the row already holds a committed R2 key, clears the
 * retired project-deletion cursor fields.
 * Deleted with the schema fields in the next landing of the same Item; the dry run (`apply:false`)
 * reads and writes nothing. */
const pageRows = 256;
const pageBytes = 1024 * 1024;
const bytesOf = (value: unknown) => JSON.stringify(value).length;
const stop = v.union(v.null(), v.literal('budget'), v.literal('cutoff'));
const totals = v.object({
  rows: v.number(),
  bytes: v.number(),
  changed: v.number(),
  blocked: v.number(),
  stopped: stop,
});

type Placed = {
  location?: 'convex' | 'r2' | undefined;
  r2Key?: string | undefined;
  r2Committed?: boolean | undefined;
  r2ConvexPurged?: boolean | undefined;
  r2BackfilledAt?: number | undefined;
  r2BackfillOperationId?: string | undefined;
};
const cleared = {
  r2ConvexPurged: undefined,
  r2BackfilledAt: undefined,
  r2BackfillOperationId: undefined,
};
/** The patch that leaves one placement shape, or `blocked` when a `convex` location has no R2 copy. */
function convert(row: Placed): { patch: Placed | null; blocked: boolean } {
  const marked =
    row.r2ConvexPurged !== undefined ||
    row.r2BackfilledAt !== undefined ||
    row.r2BackfillOperationId !== undefined;
  if (row.location === 'convex') {
    if (!(row.r2Key && row.r2Committed)) return { patch: null, blocked: true };
    return { patch: { ...cleared, location: 'r2' }, blocked: false };
  }
  return { patch: marked ? cleared : null, blocked: false };
}

export const objectsPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    rows: v.number(),
    bytes: v.number(),
    changed: v.number(),
    blocked: v.number(),
    lastCreation: v.number(),
  }),
  handler: async (ctx, { cursor, apply }) => {
    const page = await ctx.db
      .query('projectObjects')
      .order('asc')
      .paginate({ cursor, numItems: pageRows, maximumRowsRead: pageRows, maximumBytesRead: pageBytes });
    let bytes = 0,
      changed = 0,
      blocked = 0;
    for (const row of page.page) {
      bytes += bytesOf(row);
      const { patch, blocked: stuck } = convert(row);
      if (stuck) blocked++;
      if (!patch) continue;
      changed++;
      if (apply) await ctx.db.patch(row._id, patch);
    }
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      rows: page.page.length,
      bytes,
      changed,
      blocked,
      lastCreation: page.page.at(-1)?._creationTime ?? 0,
    };
  },
});

export const smallPage = internalMutation({
  args: {
    table: v.union(v.literal('projectBackups'), v.literal('projectProposals')),
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
  },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    rows: v.number(),
    bytes: v.number(),
    changed: v.number(),
    blocked: v.number(),
  }),
  handler: async (ctx, { table, cursor, apply }) => {
    const page = await ctx.db
      .query(table)
      .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: pageBytes });
    let bytes = 0,
      changed = 0,
      blocked = 0;
    for (const row of page.page as Doc<'projectBackups'>[]) {
      bytes += bytesOf(row);
      const top = convert(row);
      const receipt = row.archiveReceipt ? convert(row.archiveReceipt) : { patch: null, blocked: false };
      if (top.blocked || receipt.blocked) blocked++;
      if (!top.patch && !receipt.patch) continue;
      changed++;
      if (apply)
        await ctx.db.patch(row._id, {
          ...(top.patch ?? {}),
          ...(receipt.patch ? { archiveReceipt: { ...row.archiveReceipt!, ...receipt.patch } } : {}),
        } as never);
    }
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      rows: page.page.length,
      bytes,
      changed,
      blocked,
    };
  },
});

/** P8 gate: artifact references that are not `r2blob:` ids name no readable bytes now. A removed derived
 * row with no stored bytes is a spent tombstone of the old native sweep: it goes (`changed`). Any other
 * row with such a reference is `blocked`: it needs a conversion before the schema and reader go out. */
export const referencesPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    rows: v.number(),
    bytes: v.number(),
    changed: v.number(),
    blocked: v.number(),
  }),
  handler: async (ctx, { cursor, apply }) => {
    const page = await ctx.db
      .query('derivedArtifacts')
      .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: pageBytes });
    const bad = (ref: string | undefined) => ref !== undefined && ref !== '' && !ref.startsWith('r2blob:');
    let bytes = 0,
      changed = 0,
      blocked = 0;
    for (const row of page.page) {
      bytes += bytesOf(row);
      if (!bad(row.original) && !bad(row.storageId)) continue;
      if (row.removed && row.storageId === undefined) {
        changed++;
        if (apply) await ctx.db.delete(row._id);
      } else blocked++;
    }
    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      rows: page.page.length,
      bytes,
      changed,
      blocked,
    };
  },
});

/** The other artifact owners are small: every import, import artifact, agent grant, source zone and
 * pre-protocol import cursor, counted in one call. */
export const ownersCheck = internalMutation({
  args: {},
  returns: v.object({
    rows: v.number(),
    bytes: v.number(),
    native: v.object({
      imports: v.number(),
      importArtifacts: v.number(),
      agentGrants: v.number(),
      sourceZones: v.number(),
      importCursors: v.number(),
    }),
    more: v.boolean(),
  }),
  handler: async ctx => {
    const bad = (ref: string | undefined) => ref !== undefined && ref !== '' && !ref.startsWith('r2blob:');
    const limit = 2000;
    let rows = 0,
      bytes = 0,
      more = false;
    const take = async <T extends { _id: string }>(rowsIn: T[]) => {
      rows += rowsIn.length;
      bytes += rowsIn.reduce((n, row) => n + bytesOf(row), 0);
      more ||= rowsIn.length === limit;
      return rowsIn;
    };
    const imports = await take(await ctx.db.query('imports').take(limit));
    const artifacts = await take(await ctx.db.query('importArtifacts').take(limit));
    const grants = await take(await ctx.db.query('agentGrants').take(limit));
    const zones = await take(await ctx.db.query('sourceZones').take(limit));
    const cursors = await take(await ctx.db.query('projectGithubImports').take(limit));
    return {
      rows,
      bytes,
      native: {
        imports: imports.filter(row => bad(row.artifactKey)).length,
        importArtifacts: artifacts.filter(row => bad(row.artifactKey)).length,
        agentGrants: grants.filter(row => bad(row.artifactKey)).length,
        sourceZones: zones.filter(row => bad(row.artifactKey)).length,
        importCursors: cursors.filter(row => row.protocol === undefined && bad(row.cursor)).length,
      },
      more,
    };
  },
});

export const projectsPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    rows: v.number(),
    bytes: v.number(),
    changed: v.number(),
  }),
  handler: async (ctx, { cursor, apply }) => {
    const page = await ctx.db
      .query('hostedProjects')
      .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: pageBytes });
    let bytes = 0,
      changed = 0;
    for (const row of page.page) {
      bytes += bytesOf(row);
      if (
        row.exchangeCleanupCursor === undefined &&
        row.exchangeCleanupDone === undefined &&
        row.r2BackfillRevision === undefined
      )
        continue;
      changed++;
      if (apply)
        await ctx.db.patch(row._id, {
          exchangeCleanupCursor: undefined,
          exchangeCleanupDone: undefined,
          r2BackfillRevision: undefined,
        });
    }
    return { cursor: page.continueCursor, isDone: page.isDone, rows: page.page.length, bytes, changed };
  },
});

type Page = {
  cursor: string;
  isDone: boolean;
  rows: number;
  bytes: number;
  changed: number;
  blocked?: number;
  lastCreation?: number;
};
type Result = {
  objects: Total;
  backups: Total;
  proposals: Total;
  projects: Total;
  nativeRefs: number;
  owners: unknown;
};
type Total = {
  rows: number;
  bytes: number;
  changed: number;
  blocked: number;
  stopped: 'budget' | 'cutoff' | null;
};
/** Every page may read up to `pageBytes`; none is issued unless that much of the budget remains. */
async function drain(
  pager: (cursor: string | null) => Promise<Page>,
  budget: number,
  spent: { bytes: number },
  until?: (last: number) => boolean,
): Promise<Total> {
  const sum: Total = { rows: 0, bytes: 0, changed: 0, blocked: 0, stopped: null };
  let cursor: string | null = null;
  for (;;) {
    if (spent.bytes + pageBytes > budget) return { ...sum, stopped: 'budget' };
    const page = await pager(cursor);
    sum.rows += page.rows;
    sum.bytes += page.bytes;
    sum.changed += page.changed;
    sum.blocked += page.blocked ?? 0;
    spent.bytes += page.bytes;
    cursor = page.cursor;
    if (page.isDone) return sum;
    if (until && until(page.lastCreation ?? 0) && page.changed === 0) return { ...sum, stopped: 'cutoff' };
  }
}

/** `{"apply":false,"budgetBytes":N,"untilMs":T}`. Backups, proposals, projects and the artifact owners
 * are scanned whole; objects before `untilMs` (creation time) are scanned and the scan ends after the
 * first page past it that changes nothing, reported as `stopped: 'cutoff'`. A cutoff is not proof: the
 * deploy of the tightened schema validates every row left behind. Any native artifact reference refuses
 * the apply (`nativeRefs`), because the reader no longer opens one. */
export const run = internalAction({
  args: { apply: v.boolean(), budgetBytes: v.number(), untilMs: v.number() },
  returns: v.object({
    objects: totals,
    backups: totals,
    proposals: totals,
    projects: totals,
    nativeRefs: v.number(),
    owners: v.any(),
  }),
  handler: async (ctx, { apply, budgetBytes, untilMs }): Promise<Result> => {
    const spent = { bytes: 0 };
    const owners = await ctx.runMutation(internal.legacyFieldRetire.ownersCheck, {});
    spent.bytes += owners.bytes;
    const derived = await drain(
      (cursor): Promise<Page> =>
        ctx.runMutation(internal.legacyFieldRetire.referencesPage, { cursor, apply }),
      budgetBytes,
      spent,
    );
    const nativeRefs =
      derived.blocked + Object.values(owners.native as Record<string, number>).reduce((a, b) => a + b, 0);
    const empty: Total = { rows: 0, bytes: 0, changed: 0, blocked: 0, stopped: null };
    if ((apply && nativeRefs > 0) || owners.more) {
      return { objects: empty, backups: empty, proposals: empty, projects: empty, nativeRefs, owners };
    }
    const smallPager =
      (table: 'projectBackups' | 'projectProposals') =>
      (cursor: string | null): Promise<Page> =>
        ctx.runMutation(internal.legacyFieldRetire.smallPage, { table, cursor, apply });
    const backups = await drain(smallPager('projectBackups'), budgetBytes, spent);
    const proposals = await drain(smallPager('projectProposals'), budgetBytes, spent);
    const projects = await drain(
      (cursor): Promise<Page> => ctx.runMutation(internal.legacyFieldRetire.projectsPage, { cursor, apply }),
      budgetBytes,
      spent,
    );
    const objects = await drain(
      (cursor): Promise<Page> => ctx.runMutation(internal.legacyFieldRetire.objectsPage, { cursor, apply }),
      budgetBytes,
      spent,
      last => last > untilMs,
    );
    return { objects, backups, proposals, projects, nativeRefs, owners };
  },
});
