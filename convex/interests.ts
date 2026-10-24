import type { Doc } from './_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import type { PaginationResult } from 'convex/server';
import { inventoryPage } from './inventoryPage';
import { action } from './cliServer';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { internalQuery, internalMutation } from './cliServer';
import { interestDocument, interestReceipt, interestUpdate } from './schema';
import { readerAllowed } from './sharing';
import { invariant } from '../src/errors';
import { report } from './errors';

export const currentRow = internalQuery({
  args: { importId: v.id('imports') },
  returns: v.union(interestDocument, v.null()),
  handler: async (ctx, { importId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;

    return ctx.db
      .query('projectInterests')
      .withIndex('by_owner_and_importId', q => q.eq('owner', user.subject).eq('importId', importId))
      .unique();
  },
});
export const current = action({
  args: { importId: v.id('imports') },
  returns: v.union(interestDocument, v.null()),
  handler: async (ctx, args): Promise<Doc<'projectInterests'> | null> => {
    try {
      const row = await ctx.runQuery(
        makeFunctionReference<'query', typeof args, Doc<'projectInterests'> | null>('interests:currentRow'),
        args,
      );
      if (!row) return null;
      const rows = await ctx.runAction(
        makeFunctionReference<'action', { rows: unknown[] }, (Doc<'projectInterests'> | null)[]>(
          'inventoryAccess:read',
        ),
        { rows: [row] },
      );
      return rows[0] ?? null;
    } catch (error) {
      return report(error);
    }
  },
});
export const listRows = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(interestDocument),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('projectInterests')
      .withIndex('by_owner_and_active', q => q.eq('owner', user.subject).eq('active', true))
      .order('desc')
      .paginate(paginationOpts);
    const page = [];
    for (const row of result.page) {
      page.push(row);
    }
    return { ...result, page };
  },
});
export const list = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(interestDocument),
  handler: (ctx, args): Promise<PaginationResult<Doc<'projectInterests'>>> =>
    inventoryPage(ctx, 'interests:listRows', args),
});
export const receipt = internalQuery({
  args: { owner: v.string(), operationId: v.string() },
  returns: v.union(v.object(interestReceipt), v.null()),
  handler: async (ctx, { owner, operationId }) => {
    const row = await ctx.db
      .query('interestChanges')
      .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', operationId))
      .unique();
    return row
      ? {
          owner: row.owner,
          importId: row.importId,
          operationId: row.operationId,
          request: row.request,
          revision: row.revision,
          at: row.at,
          update: row.update,
        }
      : null;
  },
});
export const change = internalMutation({
  args: {
    owner: v.string(),
    importId: v.id('imports'),
    operationId: v.string(),
    request: v.string(),
    expectedRevision: v.number(),
    update: interestUpdate,
    repository: v.optional(v.string()),
    ref: v.optional(v.string()),
    head: v.optional(v.string()),
  },
  returns: v.object(interestReceipt),
  handler: async (ctx, input) => {
    try {
      const { owner, importId, operationId, request, expectedRevision, update } = input;
      const old = await ctx.db
        .query('interestChanges')
        .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', operationId))
        .unique();
      if (old) {
        invariant(
          old.request === request,
          'INTEREST_OPERATION_CHANGED',
          'Reconcile the original star/watch request.',
        );
        const { _id: id, _creationTime: time, ...receipt } = old;
        void id;
        void time;
        return receipt;
      }
      const row = await ctx.db
        .query('projectInterests')
        .withIndex('by_owner_and_importId', q => q.eq('owner', owner).eq('importId', importId))
        .unique();
      invariant(
        (row?.revision ?? 0) === expectedRevision,
        'INTEREST_CHANGED',
        'Your star/watch choice changed. Refresh before saving; the original request is retained.',
      );
      if (update.kind === 'seen' || update.value) {
        const job = await ctx.db.get(importId);
        invariant(
          job &&
            !job.removal &&
            (job.visibility === 'public' ||
              job.owner === owner ||
              (await readerAllowed(ctx, importId, owner))),
          'GITHUB_UNAVAILABLE',
          'This Codescape is unavailable with the current access.',
        );
        invariant(
          input.repository === job.repository && input.ref === job.ref,
          'INTEREST_CHANGED',
          'The import changed before saving.',
        );
      }
      const starred = update.kind === 'star' ? update.value : (row?.starred ?? false),
        watching = update.kind === 'watch' ? update.value : (row?.watching ?? false);
      invariant(
        update.kind !== 'seen' || watching,
        'BAD_ARGUMENT',
        'Watch this import before recording a seen revision.',
      );
      const seenHead =
        update.kind === 'seen'
          ? update.head
          : update.kind === 'watch' && update.value
            ? input.head
            : (row?.seenHead ?? null);
      invariant(
        !watching || (seenHead && /^[a-f0-9]{40,64}$/.test(seenHead)),
        'BAD_ARGUMENT',
        'A watched revision is required.',
      );
      const values = {
        owner,
        importId,
        repository: input.repository ?? row?.repository ?? '',
        ref: input.ref ?? row?.ref ?? '',
        starred,
        watching,
        seenHead: seenHead ?? null,
        active: starred || watching,
        revision: expectedRevision + 1,
      };
      if (row) await ctx.db.patch(row._id, values);
      else await ctx.db.insert('projectInterests', values);
      const receipt = {
        owner,
        importId,
        operationId,
        request,
        update,
        revision: values.revision,
        at: Date.now(),
      };
      await ctx.db.insert('interestChanges', receipt);
      return receipt;
    } catch (error) {
      return report(error);
    }
  },
});
