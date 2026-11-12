// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { findObjects, findSourceObjects, clearObjectCatalogCache } from './projectObjectFind';
import { pointBinding, pointObject } from './projectObjectPointBinding';
import { storePointObjects } from './projectObjectPointStore';
import { windowEntries } from './projectGithubImportCatalog';
import { r2Key } from './r2';
import { retainSourceKey } from './projectSourceKeyProtection';
import { invariant } from '../src/errors';

type Input = { projectId: Id<'hostedProjects'>; operationId: string; after: string | null };
type Progress = {
  mode: 'points';
  phase: 'receipts' | 'catalog';
  cursor: string | null;
  request: string | null;
  after: string | null;
  done: boolean;
  receipts: number;
  moved: number;
  pages: number;
  pageBytes: number;
  bindingBytes: number;
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** Explicit owner operation only: <=64 receipt rows /64KiB, or one <=256-pin
 * catalog page per transaction. All original-id receipts become self-contained
 * first. Each dense page's complete points commit before that page disappears.
 * No State body, R2 IO, scheduler or normal source operation is added. */
export async function pointMigration(ctx: MutationCtx, input: Input) {
  const key = `catalog-migration:${input.operationId}`;
  const old = await ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', key))
    .unique();
  invariant(
    !old || old.projectId === input.projectId,
    'WORK_OPERATION_CHANGED',
    'Resume the original point migration.',
  );
  invariant(
    !old || JSON.parse(old.value).mode === 'points',
    'WORK_OPERATION_CHANGED',
    'Resume the original catalog migration mode.',
  );
  const state: Progress = old
    ? JSON.parse(old.value)
    : {
        mode: 'points',
        phase: 'receipts',
        cursor: null,
        request: null,
        after: null,
        done: false,
        receipts: 0,
        moved: 0,
        pages: 0,
        pageBytes: 0,
        bindingBytes: 0,
      };
  if (old && (state.request === input.after || state.done)) return old.value;
  invariant(state.after === input.after, 'WORK_STALE', 'Resume the returned point migration cursor.');
  const headerKey = `source-points:${input.projectId}`;
  const header = await ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', headerKey))
    .unique();
  invariant(
    !header || header.projectId === input.projectId,
    'SOURCE_HASH_MISMATCH',
    'Source point authority belongs to another project.',
  );
  const headerId =
    header?._id ??
    (await ctx.db.insert('projectObjectReceipts', {
      projectId: input.projectId,
      key: headerKey,
      value: '1',
    }));
  if (!old && header?.value === '2') await ctx.db.patch(headerId, { value: '1' });
  clearObjectCatalogCache(ctx);
  state.request = input.after;
  if (state.phase === 'receipts') {
    const page = await ctx.db
      .query('projectObjectReceipts')
      .withIndex('by_project_and_nonce_and_value', q => q.eq('projectId', input.projectId))
      .paginate({ cursor: state.cursor, numItems: 64, maximumRowsRead: 64, maximumBytesRead: 64 * 1024 });
    state.pageBytes += page.page.reduce((sum, row) => sum + bytes(row), 0);
    const receipts = page.page.filter(row => /^[a-f0-9]{64}$/.test(row.value));
    const missing = receipts.filter(row => !row.sourceBinding);
    const objects = await findObjects(
      ctx,
      input.projectId,
      missing.map(row => row.value),
    );
    const unavailable = missing.filter(
      (row, index) =>
        !objects[index] ||
        objects[index]!.digest !== row.value ||
        !objects[index]!.sourceReferenced ||
        !(objects[index]!.recipe || objects[index]!.r2Committed),
    );
    const fallback = await findSourceObjects(
      ctx,
      input.projectId,
      unavailable.map(row => row.value),
    );
    const carriers = new Map<string, number>();
    for (const [index, receipt] of missing.entries()) {
      const current = objects[index],
        object =
          current?.digest === receipt.value &&
          current.sourceReferenced &&
          (current.recipe || current.r2Committed)
            ? current
            : fallback.get(receipt.value);
      invariant(
        object &&
          object.digest === receipt.value &&
          !object.removed &&
          (receipt.size === undefined || receipt.size === object.size),
        'SOURCE_UNAVAILABLE',
        'An original upload binding is unavailable; its catalog remains retained.',
      );
      const sourceBinding = pointBinding(object);
      if (object.pack && object.r2Key) {
        invariant(
          !carriers.has(object.r2Key) || carriers.get(object.r2Key) === object.pack.size,
          'SOURCE_HASH_MISMATCH',
          'Shared source carrier size changed.',
        );
        if (!carriers.has(object.r2Key))
          await retainSourceKey(ctx, input.projectId, {
            sha256: object.digest,
            size: object.size,
            r2Key: object.r2Key,
            pack: object.pack,
          });
        carriers.set(object.r2Key, object.pack.size);
      }
      await ctx.db.patch(receipt._id, { sourceBinding, size: object.size });
      state.receipts++;
      state.bindingBytes += bytes({ ...receipt, sourceBinding, size: object.size });
    }
    for (const receipt of receipts.filter(row => row.sourceBinding))
      pointObject(receipt, input.projectId, receipt.value);
    if (missing.length)
      await ctx.db.insert('projectCheckLogSourcePins', {
        projectId: input.projectId,
        digest: missing[0]!.value,
      });
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) state.phase = 'catalog';
  } else {
    const page = await ctx.db
      .query('projectObjectCatalog')
      .withIndex('by_project_and_first', q =>
        state.cursor === null
          ? q.eq('projectId', input.projectId)
          : q.eq('projectId', input.projectId).gt('first', state.cursor),
      )
      .paginate({ cursor: null, numItems: 1, maximumRowsRead: 1, maximumBytesRead: 64 * 1024 });
    for (const row of page.page) {
      invariant(
        row.sizes.length <= 256,
        'SOURCE_HASH_MISMATCH',
        'Retain a bounded catalog page for point publication.',
      );
      const entries = windowEntries(JSON.stringify(row));
      const saved = await storePointObjects(
        ctx,
        input.projectId,
        entries.map(pin => ({
          ...pin,
          projectId: input.projectId,
          nonce: '',
          removed: false,
          sourceReferenced: true,
          ...(pin.recipe
            ? {}
            : {
                location: 'r2' as const,
                r2Committed: true,
                r2Key: r2Key(input.projectId, pin.pack?.digest ?? pin.digest),
              }),
        })),
      );
      await ctx.db.delete(row._id);
      clearObjectCatalogCache(ctx);
      state.cursor = row.first;
      state.moved += entries.length;
      state.pages++;
      state.pageBytes += bytes(row);
      state.bindingBytes += saved.bytes;
    }
    if (!page.page.length) {
      const [remaining] = await ctx.db
        .query('projectObjectCatalog')
        .withIndex('by_project_and_first', q => q.eq('projectId', input.projectId))
        .take(1);
      if (remaining) state.cursor = null;
      else {
        await ctx.db.patch(headerId, { value: '2' });
        clearObjectCatalogCache(ctx);
        state.done = true;
      }
    }
  }
  state.after = JSON.stringify([state.phase, state.cursor, state.receipts, state.pages, state.done]);
  const value = JSON.stringify(state);
  if (old) await ctx.db.patch(old._id, { value });
  else await ctx.db.insert('projectObjectReceipts', { projectId: input.projectId, key, value });
  return value;
}
