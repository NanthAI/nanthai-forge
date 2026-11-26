// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalQuery } from './server';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Files read per call. Newest first, so a window with no writes stops on the first page. */
export const placementPageSize = 64;

/** Bytes-by-location self-metric: Convex file-storage writes in [from,to), which must stay 0
 * because bytes go to R2 (docs/data-placement.md). Read from the `_storage` system table,
 * newest first, stopping at `from`: one call when nothing was written. Counts only; no ids
 * or names leave the deployment. Deployment administrators can run this internal query on demand. */
export const convexWritten = internalQuery({
  args: {
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ count: v.number(), bytes: v.number(), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, input) => {
    try {
      const start = Date.parse(input.from),
        end = Date.parse(input.to);
      invariant(
        Number.isFinite(start) && Number.isFinite(end) && start < end,
        'BAD_ARGUMENT',
        'Use a finite window [from,to).',
      );
      const page = await ctx.db.system
        .query('_storage')
        .order('desc')
        .paginate({ cursor: input.cursor, numItems: placementPageSize });
      let count = 0,
        bytes = 0;
      for (const file of page.page)
        if (file._creationTime >= start && file._creationTime < end) {
          count++;
          bytes += file.size;
        }
      const older = page.page.length > 0 && page.page.at(-1)!._creationTime < start;
      return { count, bytes, isDone: page.isDone || older, cursor: page.continueCursor };
    } catch (error) {
      return report(error);
    }
  },
});
