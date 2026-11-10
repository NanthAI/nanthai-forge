// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { query } from './cliServer';
import { OVERLAP_ANSWERS_RETIRED } from '../src/overlap-answers-retired';

// Keep the RPC address for installed clients (overlap-answers); overlap answers no longer exist.
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: OVERLAP_ANSWERS_RETIRED });
  },
});
