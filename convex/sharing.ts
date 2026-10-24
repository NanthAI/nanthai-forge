// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, mutation, internalQuery, internalMutation } from './cliServer';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { report } from './errors';

async function owned(ctx: MutationCtx, id: Id<'imports'>, owner: string | undefined) {
  const job = await ctx.db.get(id);
  invariant(
    owner && job?.owner === owner && job.visibility === 'private' && job.removal !== 'deleting',
    'GITHUB_UNAVAILABLE',
    'This Codescape is unavailable with the current access.',
  );
  return job;
}
export const readers = query({
  args: { id: v.id('imports'), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({ reader: v.string() })),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        job = await ctx.db.get(id);
      if (!user || job?.owner !== user.subject || job.visibility !== 'private' || job.removal === 'deleting')
        return { page: [], isDone: true, continueCursor: '' };
      const result = await ctx.db
        .query('importReaders')
        .withIndex('by_importId_and_reader', q => q.eq('importId', id))
        .paginate(paginationOpts);
      return {
        page: result.page.map(row => ({ reader: row.reader })),
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const remove = mutation({
  args: { id: v.id('imports'), reader: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, reader }) => {
    try {
      await owned(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
      const grant = await ctx.db
        .query('importReaders')
        .withIndex('by_importId_and_reader', q => q.eq('importId', id).eq('reader', reader))
        .unique();
      if (grant) await ctx.db.delete(grant._id);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const add = internalMutation({
  args: { id: v.id('imports'), owner: v.string(), reader: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, owner, reader }) => {
    await owned(ctx, id, owner);
    if (owner === reader) return null; // Importers already have their own access; no redundant grant.
    const grant = await ctx.db
      .query('importReaders')
      .withIndex('by_importId_and_reader', q => q.eq('importId', id).eq('reader', reader))
      .unique();
    if (!grant) await ctx.db.insert('importReaders', { importId: id, reader });
    return null;
  },
});
export const allowed = internalQuery({
  args: { id: v.id('imports'), reader: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, reader }) => {
    return readerAllowed(ctx, id, reader);
  },
});
export async function readerAllowed(ctx: QueryCtx | MutationCtx, id: Id<'imports'>, reader: string) {
  const job = await ctx.db.get(id);
  if (!job || job.visibility !== 'private' || job.removal) return false;
  if (
    await ctx.db
      .query('importReaders')
      .withIndex('by_importId_and_reader', q => q.eq('importId', id).eq('reader', reader))
      .unique()
  )
    return true;
  // ponytail: indexed team traversal stops on the first match; use a principal index if measured fan-out reaches Convex transaction limits.
  for await (const grant of ctx.db
    .query('teamImports')
    .withIndex('by_importId_and_teamId', q => q.eq('importId', id))) {
    const team = await ctx.db.get(grant.teamId);
    if (
      team?.owner === job.owner &&
      !team.removal &&
      (await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', grant.teamId).eq('member', reader))
        .unique())
    )
      return true;
  }
  return false;
}
export const candidates = internalQuery({
  args: { reader: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.id('imports')), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { reader, paginationOpts }) => {
    const result = await ctx.db
      .query('importReaders')
      .withIndex('by_reader_and_importId', q => q.eq('reader', reader))
      .paginate(paginationOpts);
    return {
      page: result.page.map(row => row.importId),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
