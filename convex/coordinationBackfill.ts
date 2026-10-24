// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activityFields } from '../src/work-hosted-index';

/** Additive, restartable migration. Replay any cursor safely; reads/writes are one bounded page. */
export const activity = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('projectWorkRecords')
      .paginate({ cursor, numItems: 100, maximumBytesRead: 500000 });
    for (const row of page.page) {
      if (row.collection !== 'lanes' && row.collection !== 'runs') continue;
      const fields = activityFields(row.collection, JSON.parse(row.value));
      if (fields.activityAt !== row.activityAt)
        await ctx.db.patch(row._id, { activityAt: fields.activityAt });
    }
    return { cursor: page.isDone ? null : page.continueCursor, isDone: page.isDone };
  },
});
