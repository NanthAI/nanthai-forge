// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import { internal } from './_generated/api';
/** One explicit account operation, bounded pages; later sign-ins are never ended by its continuation. */
export async function endAccountDevices(
  ctx: MutationCtx,
  owner: string,
  before: number,
  cursor: string | null = null,
) {
  const page = await ctx.db
    .query('cliCredentials')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 64 * 1024 });
  for (const row of page.page)
    if (!row.revoked && row.issuedAt <= before && (row.deviceLastSeen ?? row._creationTime) <= before)
      await ctx.db.patch(row._id, { revoked: true });
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, internal.deviceEndAll.next, {
      owner,
      before,
      cursor: page.continueCursor,
    });
}
export const next = internalMutation({
  args: { owner: v.string(), before: v.number(), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await endAccountDevices(ctx, input.owner, input.before, input.cursor);
    return null;
  },
});
