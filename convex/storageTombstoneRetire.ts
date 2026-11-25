// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type QueryCtx } from './server';
import { findStoredObject } from './projectObjectFind';
import { sourceKeyReferenced } from './projectSourceKeyProtection';
import { headObject, presignDelete, r2Config } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { invariant } from '../src/errors';

/** One-off for Item c0af6cfa family F6 (owner decision 7ac252f6): the R2 copies held only by legacy
 * tombstones are deleted now, not on a calendar date, and the tombstone and cleanup-window rows go
 * with them so their tables can leave the schema. A copy still named by a live row (any object row
 * of the project at that key, a retained source key, a backup, an archive receipt or a proposal) is
 * kept and only its tombstone row is dropped; the check runs again right before each delete. The
 * receipts of the retired cleanup endpoints (parts `delete-N`, `bench-N`, `cursors`,
 * `online-retirement`) go too; the expiry and capsule receipts that share that table stay. The
 * result carries counts and bytes, never keys or contents. Removed with the tables in the
 * field-removal step; prod runs it at State B (P8 runbook, docs/operations/legacy-storage-cleanup.md). */
const pageRows = 50;
const row = v.object({
  id: v.id('legacyStorageTombstones'),
  copyKey: v.string(),
  digest: v.string(),
  size: v.number(),
  shared: v.boolean(),
});

async function namedByLiveRow(ctx: QueryCtx, copyKey: string, digest: string) {
  // v1/p/<project>/o/<sha256>: the project is the second path segment after the prefix.
  const projectId = ctx.db.normalizeId('hostedProjects', copyKey.split('/')[2] ?? '');
  if (projectId) {
    // Any object row of the project at this key, whether or not a source names it: it reads these bytes.
    const object = await findStoredObject(ctx, projectId, digest);
    if (object?.r2Key === copyKey) return true;
    if (await sourceKeyReferenced(ctx, projectId, copyKey)) return true;
  }
  const [backup] = await ctx.db
    .query('projectBackups')
    .withIndex('by_r2Key', q => q.eq('r2Key', copyKey))
    .take(1);
  if (backup) return true;
  const [archive] = await ctx.db
    .query('projectBackups')
    .withIndex('by_archive_r2Key', q => q.eq('archiveReceipt.r2Key', copyKey))
    .take(1);
  if (archive) return true;
  const [proposal] = await ctx.db
    .query('projectProposals')
    .withIndex('by_r2Key', q => q.eq('r2Key', copyKey))
    .take(1);
  return proposal !== undefined;
}

export const page = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(row), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query('legacyStorageTombstones')
      .paginate({ cursor, numItems: pageRows, maximumBytesRead: 512 * 1024 });
    const rows = [];
    for (const tombstone of result.page)
      rows.push({
        id: tombstone._id,
        copyKey: tombstone.copyKey,
        size: tombstone.size,
        digest: tombstone.digest,
        shared: await namedByLiveRow(ctx, tombstone.copyKey, tombstone.digest),
      });
    return { rows, cursor: result.isDone ? null : result.continueCursor };
  },
});

/** The same check again right before a delete, so a reference published after the page read stops it. */
export const named = internalQuery({
  args: { copyKey: v.string(), digest: v.string() },
  returns: v.boolean(),
  handler: (ctx, { copyKey, digest }) => namedByLiveRow(ctx, copyKey, digest),
});

export const forget = internalMutation({
  args: { ids: v.array(v.id('legacyStorageTombstones')) },
  returns: v.number(),
  handler: async (ctx, { ids }) => {
    invariant(ids.length <= pageRows, 'BAD_ARGUMENT', 'Forget at most one page of tombstones.');
    let removed = 0;
    for (const id of ids)
      if (await ctx.db.get(id)) {
        await ctx.db.delete(id);
        removed++;
      }
    return removed;
  },
});

export const windowCount = internalQuery({
  args: {},
  returns: v.number(),
  handler: async ctx => (await ctx.db.query('legacyStorageCleanupWindows').take(pageRows)).length,
});

export const forgetWindows = internalMutation({
  args: {},
  returns: v.number(),
  handler: async ctx => {
    const windows = await ctx.db.query('legacyStorageCleanupWindows').take(pageRows);
    for (const window of windows) await ctx.db.delete(window._id);
    return windows.length;
  },
});

const retiredPart = /^(?:(?:delete|bench)-\d+|cursors|online-retirement)$/;
/** One bounded page of the shared receipt table: the retired endpoints' receipts only. */
export const receiptPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    scanned: v.number(),
    removed: v.number(),
    bytes: v.number(),
  }),
  handler: async (ctx, { cursor, apply }) => {
    const page = await ctx.db
      .query('legacyStorageCleanupPages')
      .paginate({ cursor, numItems: 256, maximumBytesRead: 1024 * 1024 });
    let removed = 0,
      bytes = 0;
    for (const receipt of page.page)
      if (retiredPart.test(receipt.part)) {
        removed++;
        bytes += getDocumentSize(receipt);
        if (apply) await ctx.db.delete(receipt._id);
      }
    return {
      cursor: page.isDone ? null : page.continueCursor,
      scanned: page.page.length,
      removed,
      bytes,
    };
  },
});

const totals = v.object({
  tombstones: v.number(),
  tombstoneBytes: v.number(),
  shared: v.number(),
  copies: v.number(),
  copyBytes: v.number(),
  missing: v.number(),
  mismatched: v.number(),
  deleted: v.number(),
  deletedBytes: v.number(),
  rowsRemoved: v.number(),
  windows: v.number(),
  windowsRemoved: v.number(),
  receipts: v.number(),
  receiptBytes: v.number(),
});

/** `apply:false` is the dry run: it reads each copy's HEAD and writes nothing. `apply:true` deletes
 * each copy held only by a tombstone (after its HEAD size matches the pin, and verifies it is gone),
 * then drops that tombstone row; a copy whose size differs is left and reported. A rerun resumes. */
export const run = internalAction({
  args: { apply: v.boolean() },
  returns: totals,
  handler: async (ctx, { apply }) => {
    const out = {
      tombstones: 0,
      tombstoneBytes: 0,
      shared: 0,
      copies: 0,
      copyBytes: 0,
      missing: 0,
      mismatched: 0,
      deleted: 0,
      deletedBytes: 0,
      rowsRemoved: 0,
      windows: 0,
      windowsRemoved: 0,
      receipts: 0,
      receiptBytes: 0,
    };
    const config = r2Config();
    let cursor: string | null = null;
    do {
      const next: { rows: (typeof row.type)[]; cursor: string | null } = await ctx.runQuery(
        internal.storageTombstoneRetire.page,
        { cursor },
      );
      const done: Id<'legacyStorageTombstones'>[] = [];
      for (const copy of next.rows) {
        out.tombstones++;
        out.tombstoneBytes += copy.size;
        if (copy.shared) {
          out.shared++;
          done.push(copy.id);
          continue;
        }
        const head = await headObject(config, copy.copyKey);
        invariant(head.status !== 'error', 'R2_OBJECT_UNAVAILABLE', 'A retained copy could not be checked.');
        if (head.status === 'missing') {
          out.missing++;
          done.push(copy.id);
          continue;
        }
        if (head.size !== copy.size) {
          out.mismatched++;
          continue;
        }
        out.copies++;
        out.copyBytes += head.size;
        if (!apply) continue;
        if (
          await ctx.runQuery(internal.storageTombstoneRetire.named, {
            copyKey: copy.copyKey,
            digest: copy.digest,
          })
        ) {
          out.copies--;
          out.copyBytes -= head.size;
          out.shared++;
          done.push(copy.id);
          continue;
        }
        const response = await exchangeFetch(
          'R2 retained copy delete',
          await presignDelete(config, copy.copyKey),
          {
            method: 'DELETE',
          },
        );
        invariant(
          response.ok || response.status === 404,
          'R2_DELETE_FAILED',
          'A retained copy was not deleted.',
        );
        const after = await headObject(config, copy.copyKey);
        invariant(after.status === 'missing', 'R2_DELETE_FAILED', 'A deleted copy is still present.');
        out.deleted++;
        out.deletedBytes += copy.size;
        done.push(copy.id);
      }
      if (apply && done.length)
        out.rowsRemoved += await ctx.runMutation(internal.storageTombstoneRetire.forget, { ids: done });
      cursor = next.cursor;
    } while (cursor !== null);
    let at: string | null = null;
    do {
      const next: { cursor: string | null; removed: number; bytes: number } = await ctx.runMutation(
        internal.storageTombstoneRetire.receiptPage,
        { cursor: at, apply },
      );
      out.receipts += next.removed;
      out.receiptBytes += next.bytes;
      at = next.cursor;
    } while (at !== null);
    out.windows = await ctx.runQuery(internal.storageTombstoneRetire.windowCount, {});
    if (apply)
      for (let removed = 1; removed > 0;) {
        removed = await ctx.runMutation(internal.storageTombstoneRetire.forgetWindows, {});
        out.windowsRemoved += removed;
      }
    return out;
  },
});
