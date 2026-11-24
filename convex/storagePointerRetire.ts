// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation } from './server';
import { internalQuery, type QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { objectDocument } from './projectObjectFields';
import { projectBackupDocument } from './schema';

/** One-off converter for Item c0af6cfa family F6: clears old Convex file-storage pointers
 * (`storageId`) on live object rows whose bytes already read from a committed R2 object. Byte
 * readers pick R2 first for those rows (`isR2Object`), so clearing changes no read. It never
 * clears a row whose pointer still has a job: removed, purged or native-only rows, an object
 * that a saved source continuation names (its ownership proof, projectConvexSourceOwnership),
 * or any backup (its id can be an archive lookup alias, r2ArchiveSource). Those are `blocked`.
 * Pointer writers refuse with R2_REQUIRED before this runs. Dev ran it before the pointer
 * readers were deleted; prod runs it from the pinned in-between release (P8 runbook in
 * docs/operations/legacy-storage-cleanup.md). */
const tables = ['projectObjects', 'projectBackups'] as const;
type Table = (typeof tables)[number];
const pageRows = 256;
const pageBytes = 1024 * 1024;
const blockedDetail = 20;
const maxContinuationRefs = 1000;
const maxPasses = 3;

type Row = Doc<'projectObjects'> | Doc<'projectBackups'>;
type Cursor = { id: string; at: number };
const eligible = (table: Table, row: Row, owned: ReadonlySet<string>) =>
  table === 'projectObjects' &&
  !(row as Doc<'projectObjects'>).removed &&
  !(row as Doc<'projectObjects'>).purged &&
  row.location === 'r2' &&
  !!row.r2Committed &&
  !!row.r2Key &&
  !owned.has(row.storageId!);

const pageResult = {
  cursor: v.union(v.string(), v.null()),
  scanned: v.number(),
  cleared: v.number(),
  blocked: v.number(),
  blockedIds: v.array(v.string()),
  readBytes: v.number(),
  writtenBytes: v.number(),
};

/** Exact keyset page over the set ids of `by_storage`, highest id first. The cursor names the
 * last row by (storageId, _creationTime), so a page stops at its row and byte caps even inside one
 * large group of equal ids and the next page resumes inside that group. A cleared row leaves the
 * range. At most `pageRows` rows and `pageBytes` read (a single larger row is read alone). */
export const page = internalMutation({
  args: {
    table: v.union(...tables.map(name => v.literal(name))),
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    owned: v.optional(v.array(v.string())),
  },
  returns: v.object(pageResult),
  handler: async (ctx, { table, cursor, apply, owned = [] }) => {
    invariant(owned.length <= maxContinuationRefs, 'BAD_ARGUMENT', 'Too many continuation refs.');
    const keep = new Set(owned);
    const after: Cursor | null = cursor === null ? null : JSON.parse(cursor);
    // oxlint-disable-next-line typescript/no-explicit-any -- one range shape over both tables' by_storage
    const index = (range: (q: any) => any) =>
      ctx.db
        .query(table as Table)
        .withIndex('by_storage', range)
        .order('desc') as unknown as AsyncIterable<Row>;
    const ranges = after
      ? [
          // The rest of the group the last page stopped in, then every lower id.
          index(q => q.eq('storageId', after.id as Id<'_storage'>).lt('_creationTime', after.at)),
          index(q => q.gt('storageId', undefined).lt('storageId', after.id as Id<'_storage'>)),
        ]
      : [index(q => q.gt('storageId', undefined))];
    const out = {
      scanned: 0,
      cleared: 0,
      blocked: 0,
      blockedIds: [] as string[],
      readBytes: 0,
      writtenBytes: 0,
    };
    let last: Cursor | null = null,
      full = false;
    scan: for (const rows of ranges)
      for await (const row of rows) {
        const size = getDocumentSize(row);
        if (out.scanned >= pageRows || (out.scanned > 0 && out.readBytes + size > pageBytes)) {
          full = true;
          break scan;
        }
        out.readBytes += size;
        out.scanned++;
        last = { id: row.storageId!, at: row._creationTime };
        if (!eligible(table, row, keep)) {
          out.blocked++;
          if (out.blockedIds.length < blockedDetail) out.blockedIds.push(row._id);
          continue;
        }
        out.cleared++;
        if (!apply) continue;
        await ctx.db.patch(row._id, { storageId: undefined });
        // The rewritten row is the read row less its pointer.
        out.writtenBytes += size - getDocumentSize({ storageId: row.storageId! }) + getDocumentSize({});
      }
    return { ...out, cursor: full && last ? JSON.stringify(last) : null };
  },
});

/** Every `_storage` id a saved source continuation names (cursor JSON, task input, work return
 * refs), nested JSON strings included. One bounded page of one table per call. */
const continuationTables = ['projectSourceSteps', 'projectSourceTasks', 'projectWorkGenerations'] as const;
function storageRefs(ctx: Pick<QueryCtx, 'db'>, value: unknown, found: Set<string>, depth = 0) {
  if (depth > 32) return;
  if (typeof value === 'string') {
    if (ctx.db.system.normalizeId('_storage', value)) found.add(value);
    else if (/^[[{]/.test(value))
      try {
        storageRefs(ctx, JSON.parse(value), found, depth + 1);
      } catch {
        // Not JSON: an ordinary string.
      }
  } else if (Array.isArray(value)) for (const item of value) storageRefs(ctx, item, found, depth + 1);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) storageRefs(ctx, item, found, depth + 1);
}
export const continuationPage = internalQuery({
  args: {
    table: v.union(...continuationTables.map(name => v.literal(name))),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    refs: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
    readBytes: v.number(),
  }),
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db
      .query(table)
      .paginate({ cursor, numItems: 2048, maximumBytesRead: 4 * 1024 * 1024 });
    const found = new Set<string>();
    let readBytes = 0;
    for (const row of page.page) {
      readBytes += getDocumentSize(row);
      const { _id, _creationTime, ...fields } = row as Record<string, unknown>;
      void _id;
      void _creationTime;
      storageRefs(ctx, fields, found);
    }
    return { refs: [...found], cursor: page.isDone ? null : page.continueCursor, readBytes };
  },
});

const passResult = v.object({
  table: v.string(),
  pages: v.number(),
  scanned: v.number(),
  cleared: v.number(),
  blocked: v.number(),
  blockedIds: v.array(v.string()),
  readBytes: v.number(),
  writtenBytes: v.number(),
});
type Pass = typeof passResult.type;

/** Operator entry point: `apply:false` is the dry run. Writers already refuse new pointers; an
 * apply still ends with a terminal rescan that must clear nothing, so a pointer written behind the
 * cursor mid-run is caught in the same run (at most three passes, then it refuses). One mutation
 * per page, no scheduled work. */
export const run = internalAction({
  args: { apply: v.boolean() },
  returns: v.object({
    continuationRefs: v.number(),
    continuationReadBytes: v.number(),
    passes: v.array(v.array(passResult)),
  }),
  handler: async (ctx, { apply }) => {
    const owned = new Set<string>();
    let continuationReadBytes = 0;
    for (const table of continuationTables) {
      let cursor: string | null = null;
      do {
        const next: { refs: string[]; cursor: string | null; readBytes: number } = await ctx.runQuery(
          internal.storagePointerRetire.continuationPage,
          { table, cursor },
        );
        next.refs.forEach(ref => owned.add(ref));
        continuationReadBytes += next.readBytes;
        cursor = next.cursor;
      } while (cursor !== null);
    }
    invariant(
      owned.size <= maxContinuationRefs,
      'BAD_ARGUMENT',
      'Saved continuations name too many old storage ids; settle those jobs first.',
    );
    const passes: Pass[][] = [];
    for (let pass = 0; pass < maxPasses; pass++) {
      const totals: Pass[] = [];
      for (const table of tables) {
        const total: Pass = {
          table,
          pages: 0,
          scanned: 0,
          cleared: 0,
          blocked: 0,
          blockedIds: [],
          readBytes: 0,
          writtenBytes: 0,
        };
        let cursor: string | null = null;
        do {
          const next: {
            cursor: string | null;
            scanned: number;
            cleared: number;
            blocked: number;
            blockedIds: string[];
            readBytes: number;
            writtenBytes: number;
          } = await ctx.runMutation(internal.storagePointerRetire.page, {
            table,
            cursor,
            apply,
            owned: [...owned],
          });
          total.pages++;
          total.scanned += next.scanned;
          total.cleared += next.cleared;
          total.blocked += next.blocked;
          for (const id of next.blockedIds)
            if (total.blockedIds.length < blockedDetail) total.blockedIds.push(id);
          total.readBytes += next.readBytes;
          total.writtenBytes += next.writtenBytes;
          cursor = next.cursor;
        } while (cursor !== null);
        totals.push(total);
      }
      passes.push(totals);
      // A dry run reads once; an apply ends when a full rescan clears nothing.
      if (!apply || (pass > 0 && totals.every(total => total.cleared === 0))) break;
      invariant(
        pass < maxPasses - 1,
        'WORK_STALE',
        'Old storage pointers keep appearing; stop and find the writer.',
      );
    }
    return { continuationRefs: owned.size, continuationReadBytes, passes };
  },
});

/** Proof input for `storagePointerProof:read`: exactly the requested rows, or it refuses. */
export const proofRows = internalQuery({
  args: { objects: v.array(v.id('projectObjects')), backups: v.array(v.id('projectBackups')) },
  returns: v.object({
    objects: v.array(objectDocument),
    backups: v.array(projectBackupDocument),
    owners: v.array(v.string()),
  }),
  handler: async (ctx, { objects, backups }) => {
    invariant(objects.length + backups.length <= 64, 'BAD_ARGUMENT', 'Prove at most 64 rows at once.');
    invariant(
      new Set([...objects, ...backups]).size === objects.length + backups.length,
      'BAD_ARGUMENT',
      'Name each proof row once.',
    );
    const present = async <T>(ids: string[], rows: (T | null)[]) => {
      invariant(
        rows.every(row => row !== null),
        'BAD_ARGUMENT',
        `Proof row is missing: ${ids[rows.indexOf(null)]}.`,
      );
      return rows as T[];
    };
    const found = await present(backups, await Promise.all(backups.map(id => ctx.db.get(id))));
    // The owner resolves a backup's archive alias under current access, as a client would.
    const owners = await Promise.all(found.map(async row => (await ctx.db.get(row.projectId))?.owner ?? ''));
    return {
      objects: await present(objects, await Promise.all(objects.map(id => ctx.db.get(id)))),
      backups: found,
      owners,
    };
  },
});
