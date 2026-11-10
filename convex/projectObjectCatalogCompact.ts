// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { activeOwnedProject } from './projectAuthority';
import { catalogEligible, catalogPin, storeCatalogObjects } from './projectObjectCatalogStore';
import { findObjects } from './projectObjectFind';
import { invariant } from '../src/errors';
const address = { projectId: v.id('hostedProjects'), actor: v.string() };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
type Receipt = {
  after: string | null;
  request: string | null;
  moved: number;
  readBytes: number;
  writtenBytes: number;
  deletedBytes: number;
  done: boolean;
};
/** Explicit foreground migration; one idempotent transaction per <=64-row,
 * <=64 KiB page. No scheduler, source downloads, export or idle work. */
export const step = internalMutation({
  args: { ...address, operationId: v.string(), after: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const key = `catalog-migration:${input.operationId}`;
    const old = await ctx.db
      .query('projectObjectReceipts')
      .withIndex('by_key', q => q.eq('key', key))
      .unique();
    invariant(
      !old || old.projectId === input.projectId,
      'WORK_OPERATION_CHANGED',
      'Resume the original catalog migration.',
    );
    const receipt: Receipt = old
      ? JSON.parse(old.value)
      : { after: null, request: null, moved: 0, readBytes: 0, writtenBytes: 0, deletedBytes: 0, done: false };
    if (old && (receipt.request === input.after || receipt.done)) return old.value;
    invariant(receipt.after === input.after, 'WORK_STALE', 'Resume the returned catalog cursor.');
    const selected = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q =>
        input.after === null
          ? q.eq('projectId', input.projectId)
          : q.eq('projectId', input.projectId).gt('digest', input.after),
      )
      .paginate({ cursor: null, numItems: 64, maximumRowsRead: 64, maximumBytesRead: 64 * 1024 });
    const rows = selected.page.filter(catalogEligible);
    const saved = await storeCatalogObjects(ctx, input.projectId, rows.map(catalogPin), key);
    let written = saved.bytes;
    for (const row of rows) {
      // Old id retries must still authorize and reconcile after its descriptor moves.
      const value = { projectId: input.projectId, key: row._id, value: row.digest };
      await ctx.db.insert('projectObjectReceipts', value);
      written += bytes(value);
      await ctx.db.delete(row._id);
    }
    const result: Receipt = {
      request: input.after,
      after: selected.page.at(-1)?.digest ?? input.after,
      moved: receipt.moved + rows.length,
      readBytes:
        receipt.readBytes + saved.readBytes + selected.page.reduce((sum, row) => sum + bytes(row), 0),
      writtenBytes: receipt.writtenBytes + written,
      deletedBytes: receipt.deletedBytes + rows.reduce((sum, row) => sum + bytes(row), 0),
      done: selected.isDone,
    };
    const value = JSON.stringify(result);
    if (old) await ctx.db.patch(old._id, { value });
    else await ctx.db.insert('projectObjectReceipts', { projectId: input.projectId, key, value });
    return value;
  },
});
/** Every original migrated digest remains resolvable at its committed project
 * binding. This independent paged read checks all migrated objects, not a sample. */
export const verify = internalQuery({
  args: { ...address, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const page = await ctx.db
      .query('projectObjectReceipts')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .paginate({ cursor: input.cursor, numItems: 256, maximumRowsRead: 256, maximumBytesRead: 128 * 1024 });
    const receipts = page.page.filter(row => !row.key.startsWith('catalog-migration:'));
    const objects = await findObjects(
      ctx,
      input.projectId,
      receipts.map(row => row.value),
    );
    invariant(
      objects.every(
        object =>
          object && !object.removed && object.sourceReferenced && (object.recipe || object.r2Committed),
      ),
      'SOURCE_UNAVAILABLE',
      'A migrated object is unreachable.',
    );
    return JSON.stringify({ checked: receipts.length, cursor: page.continueCursor, done: page.isDone });
  },
});
