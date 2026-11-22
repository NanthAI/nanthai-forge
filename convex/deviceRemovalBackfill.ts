// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { internalMutation } from './server';

/** One-off repair for removals recorded before the key and code were cleared. */
export const run = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    scanned: v.number(),
    cleared: v.number(),
  }),
  handler: async (ctx, { cursor }) => {
    if (process.env.CONVEX_CLOUD_URL !== 'https://benevolent-wildebeest-974.convex.cloud')
      throw new ConvexError({
        code: 'PROJECT_UNAVAILABLE',
        message: 'This device repair is scoped to the approved Forge dev deployment.',
      });
    // The default creation-time order stays stable as optional fields are cleared.
    const page = await ctx.db.query('cliCredentials').paginate({ cursor, numItems: 100 });
    let cleared = 0;
    for (const row of page.page) {
      if (row.removed !== true || (row.deviceKey === undefined && row.deviceCode === undefined)) continue;
      await ctx.db.patch(row._id, { deviceKey: undefined, deviceCode: undefined });
      cleared++;
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      cleared,
    };
  },
});
