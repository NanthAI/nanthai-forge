// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './cliServer';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { readerAllowed } from './sharing';
import { trackArtifact } from './artifacts';
import { invariant } from '../src/errors';
import { report } from './errors';

const unavailable = 'This Codescape is unavailable with the current access.';
const command = { importId: v.id('imports'), operationId: v.string() };
async function removeOwned(
  ctx: MutationCtx,
  args: { importId: Id<'imports'>; operationId: string },
  owner: string,
) {
  invariant(owner && args.operationId.trim(), 'GITHUB_UNAVAILABLE', unavailable);
  const receipt = await ctx.db
    .query('importRemovalOperations')
    .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', args.operationId))
    .unique();
  if (receipt) {
    invariant(receipt.target === args.importId, 'BAD_ARGUMENT', 'Reconcile the original removal request.');
  }
  const job = await ctx.db.get(args.importId);
  if (!job && receipt) return null;
  invariant(job && job.owner === owner, 'GITHUB_UNAVAILABLE', unavailable);
  if (!receipt)
    await ctx.db.insert('importRemovalOperations', {
      owner,
      operationId: args.operationId,
      target: args.importId,
    });
  if (job.removal === 'deleting' && job.task) {
    const task = await ctx.db.system.get(job.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return null;
  }
  if (job.task) {
    const task = await ctx.db.system.get(job.task);
    if (task?.state.kind === 'pending') await ctx.scheduler.cancel(job.task);
  }
  await trackArtifact(ctx, job._id, job.artifactKey);
  const task = await ctx.scheduler.runAfter(0, internal.lifecycle.purge, { id: job._id });
  await ctx.db.patch(job._id, {
    removal: 'deleting',
    removedAt: job.removedAt ?? Date.now(),
    generation: job.generation + 1,
    syncRevision: (job.syncRevision ?? 0) + 1,
    task,
  });
  return null;
}
export const remove = mutation({
  args: command,
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', unavailable);
      return await removeOwned(ctx, args, user.subject);
    } catch (error) {
      return report(error);
    }
  },
});
// Deployment operators supply the selected account explicitly; this is never a public endpoint.
export const removeAsOwner = internalMutation({
  args: { ...command, owner: v.string() },
  returns: v.null(),
  handler: async (ctx, { owner, ...args }) => removeOwned(ctx, args, owner),
});
const item = v.object({
  id: v.id('imports'),
  repository: v.string(),
  ref: v.string(),
  phase: v.string(),
  createdAt: v.number(),
});
async function ownedPage(
  ctx: Pick<QueryCtx, 'db'>,
  owner: string,
  paginationOpts: { numItems: number; cursor: string | null },
) {
  const result = await ctx.db
    .query('imports')
    .withIndex('by_owner_and_visibility', q => q.eq('owner', owner))
    .order('desc')
    .paginate(paginationOpts);
  return {
    ...result,
    page: result.page
      .filter(row => !row.removal)
      .map(row => ({
        id: row._id,
        repository: row.repository,
        ref: row.ref,
        phase: row.phase,
        createdAt: row._creationTime,
      })),
  };
}
export const listAsOwner = internalQuery({
  args: { owner: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { owner, paginationOpts }) => ownedPage(ctx, owner, paginationOpts),
});
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    return user
      ? ownedPage(ctx, user.subject, paginationOpts)
      : { page: [], isDone: true, continueCursor: '' };
  },
});
// Reactive lifecycle projection for action-backed shared lists. No source metadata or existence is exposed.
export const removed = query({
  args: { ids: v.array(v.id('imports')) },
  returns: v.array(v.id('imports')),
  handler: async (ctx, { ids }) => {
    const user = await ctx.auth.getUserIdentity();
    const removed: Id<'imports'>[] = [];
    for (const id of new Set(ids)) {
      const job = await ctx.db.get(id);
      if (
        !job ||
        job.removal ||
        !(
          job.visibility === 'public' ||
          job.owner === user?.subject ||
          (user && (await readerAllowed(ctx, id, user.subject)))
        )
      )
        removed.push(id);
    }
    return removed;
  },
});
