// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, getDocumentSize } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator, type GenericDocument } from 'convex/server';
import { internalMutation, internalQuery, query, type QueryCtx, type MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import {
  accountActor,
  ownedMetadata,
  incomingCurrent,
  type LeaveKind,
  type ResourceKind,
} from './accountResources';
import { accountReceipt, accountItemState, leaveKind } from './accountTypes';
import { invariant } from '../src/errors';
import { metadataBytes } from './accountMetadata';
import { digest } from '../src/state/hash';
import { report } from './errors';

async function owned(ctx: QueryCtx | MutationCtx, operationId: string) {
  const owner = await accountActor(ctx),
    r = await ctx.db
      .query('accountOperations')
      .withIndex('by_owner_and_operation', q => q.eq('owner', owner).eq('operationId', operationId))
      .unique();
  invariant(r, 'ACCOUNT_UNAVAILABLE', 'This Forge data operation is unavailable.');
  return r;
}
const receipt = (r: Doc<'accountOperations'>) => ({
  operationId: r.operationId,
  request: r.request,
  stage: r.stage,
  at: r.at,
  kept: r.kept ?? 0,
});
export const original = internalQuery({
  args: { operationId: v.string() },
  returns: v.any(),
  handler: async (ctx, { operationId }) => {
    try {
      const owner = await accountActor(ctx);
      return ctx.db
        .query('accountOperations')
        .withIndex('by_owner_and_operation', q => q.eq('owner', owner).eq('operationId', operationId))
        .unique();
    } catch (e) {
      return report(e);
    }
  },
});
export const register = internalMutation({
  args: {
    operationId: v.string(),
    request: v.string(),
    expectedItems: v.number(),
    leave: v.array(leaveKind),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    try {
      const owner = await accountActor(ctx),
        old = await ctx.db
          .query('accountOperations')
          .withIndex('by_owner_and_operation', q => q.eq('owner', owner).eq('operationId', input.operationId))
          .unique();
      if (old) {
        invariant(
          old.request === input.request,
          'ACCOUNT_OPERATION_CHANGED',
          'Reconcile your original selected Forge data operation.',
        );
        return old;
      }
      const id = await ctx.db.insert('accountOperations', {
        ...input,
        owner,
        stage: 'preparing',
        captured: [],
        pending: 0,
        at: Date.now(),
      });
      return ctx.db.get(id);
    } catch (e) {
      return report(e);
    }
  },
});
const appendInput = v.object({
  key: v.string(),
  kind: v.string(),
  resourceId: v.string(),
  pin: v.string(),
  /** Hidden (incoming) rows only: the exact row bytes the cleanup verified against its review. */
  observed: v.optional(v.string()),
  operationId: v.string(),
  hidden: v.boolean(),
});
/** One append reads at most this much of the selected rows (plus the last row it checks), whatever their size. */
export const APPEND_BYTES = 256 * 1024;
/** Appends items in order and returns how many it took: it stops early once it has read APPEND_BYTES, and the caller
 * sends the rest again (review ae15c5ca: names have no length limit, so a fixed count does not bound a read). */
export const append = internalMutation({
  args: { operationId: v.string(), items: v.array(appendInput) },
  returns: v.number(),
  handler: async (ctx, { operationId, items }) => {
    try {
      const account = await owned(ctx, operationId);
      invariant(
        account.stage === 'preparing',
        'ACCOUNT_OPERATION_CHANGED',
        'This original selection is already sealed.',
      );
      let added = 0,
        taken = 0,
        bytes = 0;
      const read = (doc: GenericDocument | null) => {
        if (doc) bytes += getDocumentSize(doc);
      };
      for (const item of items) {
        if (taken && bytes >= APPEND_BYTES) break;
        taken++;
        // A stored item never changes (invariant 2a, comment c9ea033e): a retry finds it with the same pin or refuses.
        const old = await ctx.db
          .query('accountItems')
          .withIndex('by_account_and_key', q => q.eq('accountId', account._id).eq('key', item.key))
          .unique();
        if (old)
          invariant(
            old.resourceId === item.resourceId && old.kind === item.kind && old.hidden === item.hidden,
            'ACCOUNT_OPERATION_CHANGED',
            'Original selection changed.',
          );
        invariant(
          !old || old.pin === item.pin,
          'ACCOUNT_CHANGED',
          'Something on your list changed after your review. Review again; nothing was deleted.',
        );
        // Every item, stored or not, is checked against what Forge holds now, in this transaction.
        let expected: Doc<'accountItems'>['expected'];
        if (!item.hidden) {
          const value = await ownedMetadata(
            ctx,
            item.kind as ResourceKind,
            item.resourceId,
            account.owner,
            read,
          );
          invariant(
            value && digest(metadataBytes(value)) === item.pin,
            'ACCOUNT_CHANGED',
            'Selected metadata changed. The original resources are preserved.',
          );
          if (old) continue;
          const r = value as {
            revision?: number;
            creation?: number;
          };
          expected = {
            ...('revision' in r ? { revision: r.revision } : {}),
            ...('creation' in r ? { creation: r.creation } : {}),
          };
          if (item.kind === 'view') {
            const row = await ctx.db.get(item.resourceId as Id<'savedViews'>);
            read(row);
            expected.creationOperationId = row!.operationId;
          }
        } else {
          const value = await incomingCurrent(
            ctx,
            item.kind as LeaveKind,
            item.resourceId,
            account.owner,
            read,
          );
          invariant(
            value &&
              item.observed !== undefined &&
              metadataBytes(value) === item.observed &&
              digest(item.observed) === item.pin,
            'ACCOUNT_CHANGED',
            'What is shared with you changed after your review. Review again; nothing was deleted.',
          );
          if (old) continue;
        }
        await ctx.db.insert('accountItems', {
          owner: account.owner,
          accountId: account._id,
          key: item.key,
          kind: item.kind,
          resourceId: item.resourceId,
          pin: item.pin,
          operationId: item.operationId,
          hidden: item.hidden,
          state: 'pending',
          ...(expected ? { expected } : {}),
        });
        added++;
      }
      if (added) await ctx.db.patch(account._id, { pending: account.pending + added });
      return taken;
    } catch (e) {
      return report(e);
    }
  },
});
export const captured = internalMutation({
  args: { operationId: v.string(), kind: leaveKind },
  returns: v.null(),
  handler: async (ctx, { operationId, kind }) => {
    try {
      const r = await owned(ctx, operationId);
      if (!r.captured.includes(kind)) await ctx.db.patch(r._id, { captured: [...r.captured, kind] });
      return null;
    } catch (e) {
      return report(e);
    }
  },
});
export const items = internalQuery({
  /** `visible`: only the selected items (not what is left of others' things). */
  args: {
    operationId: v.string(),
    paginationOpts: paginationOptsValidator,
    visible: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, { operationId, paginationOpts, visible }) => {
    try {
      const r = await owned(ctx, operationId);
      return visible
        ? ctx.db
            .query('accountItems')
            .withIndex('by_account_and_hidden_and_key', q => q.eq('accountId', r._id).eq('hidden', false))
            .paginate(paginationOpts)
        : ctx.db
            .query('accountItems')
            .withIndex('by_account_and_key', q => q.eq('accountId', r._id))
            .paginate(paginationOpts);
    } catch (e) {
      return report(e);
    }
  },
});
export const seal = internalMutation({
  /** `verifiedTotal`: every item (owned and shared) this preparation verified. Items are only ever added, and each
   * adds one to `pending`, so equal counts mean the stored set is exactly the verified one (an overlapping preparation
   * that added anything makes this refuse). */
  args: {
    operationId: v.string(),
    verifiedRequest: v.string(),
    verifiedItems: v.number(),
    verifiedTotal: v.number(),
  },
  returns: accountReceipt,
  handler: async (ctx, input) => {
    try {
      const r = await owned(ctx, input.operationId);
      if (r.stage !== 'preparing') return receipt(r);
      invariant(
        r.request === input.verifiedRequest &&
          r.expectedItems === input.verifiedItems &&
          r.pending === input.verifiedTotal &&
          r.leave.every(k => r.captured.includes(k)),
        'ACCOUNT_OPERATION_CHANGED',
        'The original selection is incomplete. Reconcile it before removal.',
      );
      await ctx.db.patch(r._id, { stage: 'ready' });
      return { ...receipt(r), stage: 'ready' as const };
    } catch (e) {
      return report(e);
    }
  },
});
export const complete = internalMutation({
  args: { operationId: v.string() },
  returns: accountReceipt,
  handler: async (ctx, { operationId }) => {
    try {
      const r = await owned(ctx, operationId);
      invariant(
        r.stage !== 'preparing',
        'ACCOUNT_OPERATION_CHANGED',
        'Reconcile the original selection first.',
      );
      if (r.pending) return receipt(r);
      await ctx.db.patch(r._id, { stage: 'completed' });
      return { ...receipt(r), stage: 'completed' as const };
    } catch (e) {
      return report(e);
    }
  },
});
export const read = query({
  args: { operationId: v.string() },
  returns: accountReceipt,
  handler: async (ctx, { operationId }) => {
    try {
      return receipt(await owned(ctx, operationId));
    } catch (e) {
      return report(e);
    }
  },
});
export const progress = query({
  args: { operationId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ kind: v.string(), id: v.string(), state: accountItemState })),
  handler: async (ctx, { operationId, paginationOpts }) => {
    try {
      const r = await owned(ctx, operationId),
        result = await ctx.db
          .query('accountItems')
          .withIndex('by_account_and_hidden_and_key', q => q.eq('accountId', r._id).eq('hidden', false))
          .paginate(paginationOpts);
      return {
        ...result,
        page: result.page.map(item => ({ kind: item.kind, id: item.resourceId, state: item.state })),
      };
    } catch (e) {
      return report(e);
    }
  },
});
export const receipts = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(accountReceipt),
  handler: async (ctx, { paginationOpts }) => {
    try {
      const owner = await accountActor(ctx),
        result = await ctx.db
          .query('accountOperations')
          .withIndex('by_owner', q => q.eq('owner', owner))
          .order('desc')
          .paginate(paginationOpts);
      return { ...result, page: result.page.map(receipt) };
    } catch (e) {
      return report(e);
    }
  },
});
