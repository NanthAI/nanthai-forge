// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { mutation, query } from './cliServer';
import { OVERLAP_ANSWERS_RETIRED } from '../src/overlap-answers-retired';

// Keep RPC addresses for installed clients (ack, peer-ack, overlap-acks); overlap answers no longer exist.
export const append = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: OVERLAP_ANSWERS_RETIRED });
  },
});
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    signals: v.optional(v.boolean()),
  },
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: OVERLAP_ANSWERS_RETIRED });
  },
});
