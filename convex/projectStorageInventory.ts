// SPDX-License-Identifier: Apache-2.0
import { v, getDocumentSize, type Value } from 'convex/values';
import { internalQuery, internalMutation, type QueryCtx } from './server';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { cleanupReceipt, recordCleanup } from './legacyStorageReceipts';
import { rowReferences, valuesAt, type ProjectPurgeTable } from './projectPurgeInventory';
import { removeExclusive } from './projectStorage';
import { storageOwners, storageOwner, projectOwnedScope } from './projectStorageOwnership';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import type { Id } from './_generated/dataModel';

const selection = { table: v.string(), field: v.string() };
type Row = { _id: string; _creationTime: number } & Record<string, Value>;
type OwnerQuery = {
  withIndex: (
    index: string,
    range: (q: { gt: (field: string, value: unknown) => unknown }) => unknown,
  ) => {
    take: (n: number) => Promise<Row[]>;
  };
};

export const describe = internalQuery({
  args: {},
  returns: v.array(v.object({ table: v.string(), field: v.string(), parent: v.string(), index: v.string() })),
  handler: async () => storageOwners(),
});

/** Four distinct owners, not four adjacent documents. Each seek skips the
 * previous owner's entire payload range. At most 8 MiB including parent rows. */
export async function ownerPage(
  ctx: QueryCtx,
  input: { table: string; field: string; after: string | null },
) {
  const owner = storageOwner(input.table, input.field);
  const page = [];
  let after = input.after;
  for (let n = 0; n < 4; n++) {
    // oxlint-disable-next-line forge/convex-bounded-query -- the cast exposes only an indexed single-row seek
    const query = ctx.db.query(input.table as never) as unknown as OwnerQuery;
    const [row] = await query.withIndex(owner.index, q => q.gt(owner.field, after ?? '')).take(1);
    if (!row) return { page, after, isDone: true };
    const id = row[owner.field];
    invariant(typeof id === 'string', 'BAD_ARGUMENT', 'Owner index contains a non-id owner.');
    const parentId = ctx.db.normalizeId(owner.parent as never, id);
    const parent = parentId ? ((await ctx.db.get(parentId)) as Row | null) : null;
    page.push({
      ownerId: id,
      exists: parent !== null,
      deleted: Boolean(parent && 'removal' in parent && parent.removal === 'deleted'),
      sampleBytes: getDocumentSize(row),
    });
    after = id;
  }
  return { page, after, isDone: false };
}

export const owners = internalQuery({
  args: { ...selection, after: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(
      v.object({ ownerId: v.string(), exists: v.boolean(), deleted: v.boolean(), sampleBytes: v.number() }),
    ),
    after: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: ownerPage,
});

/** Exact pins + a durable page receipt make unknown outcomes safe to retry.
 * Existing deleted projects use projectLifecycle's full purge instead. This
 * endpoint removes only rows with a currently absent ownership record. */
export const purgeOrphans = internalMutation({
  args: {
    ...selection,
    ownerId: v.string(),
    operationId: v.string(),
    part: v.string(),
    pins: v.array(v.object({ id: v.string(), sha256: v.string() })),
  },
  returns: v.object({ deleted: v.number(), bytes: v.number() }),
  handler: async (wrapped, input) => {
    const ctx = projectPurgeWriter(wrapped);
    const request = digest(JSON.stringify(input));
    const old = await cleanupReceipt(ctx, input.operationId, `orphan:${input.part}`, request);
    if (old) return old;
    const owner = storageOwner(input.table, input.field);
    const ownerId = ctx.db.normalizeId(owner.parent as never, input.ownerId);
    invariant(
      ownerId && !(await ctx.db.get(ownerId)),
      'BAD_ARGUMENT',
      'Only an absent owner permits orphan removal.',
    );
    invariant(
      input.operationId.length > 0 &&
        input.part.length > 0 &&
        input.pins.length > 0 &&
        input.pins.length <= 8 &&
        new Set(input.pins.map(pin => pin.id)).size === input.pins.length,
      'BAD_ARGUMENT',
      'Use an original operation id and at most eight unique pinned rows.',
    );
    const rows: Row[] = [];
    for (const pin of input.pins) {
      const id = ctx.db.normalizeId(input.table as never, pin.id);
      const row = id ? ((await ctx.db.get(id)) as Row | null) : null;
      invariant(
        row &&
          row[input.field] === input.ownerId &&
          digest(JSON.stringify(row)) === pin.sha256 &&
          (input.field !== 'projectId' || projectOwnedScope(input.table, row)),
        'BAD_ARGUMENT',
        'A pinned row or its ownership changed; retain the page.',
      );
      rows.push(row);
    }
    const references = rowReferences(input.table as ProjectPurgeTable);
    for (const row of rows) {
      for (const path of references.tasks)
        for (const id of valuesAt(row, path)) {
          const task = await ctx.db.system.get(id as Id<'_scheduled_functions'>);
          if (task?.state.kind === 'pending') await ctx.scheduler.cancel(id as Id<'_scheduled_functions'>);
        }
      await ctx.db.delete(row._id as never);
      for (const path of references.files)
        for (const id of valuesAt(row, path)) await removeExclusive(ctx, id as Id<'_storage'>, row._id);
    }
    const result = { deleted: rows.length, bytes: rows.reduce((n, row) => n + getDocumentSize(row), 0) };
    await recordCleanup(ctx, input.operationId, `orphan:${input.part}`, request, result);
    return result;
  },
});
