// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Bounded counter rows for convex/abuseLimits.ts: a fixed number of shards per scope,
 * reset in place when a window ends, so rows never grow with traffic and nothing idles. */
export const abuseLimitTables = {
  /** Calls by signed-out readers of one public project in the current window. */
  projectReadBudgets: defineTable({
    projectId: v.id('hostedProjects'),
    shard: v.number(),
    windowStart: v.number(),
    count: v.number(),
  }).index('by_project_and_shard', ['projectId', 'shard']),
  /** Reserved stored objects and bytes of one project (counted from first use). `pending*`
   * is the part not yet added to the owner's account total. */
  projectStorageUsage: defineTable({
    projectId: v.id('hostedProjects'),
    shard: v.number(),
    objects: v.number(),
    bytes: v.number(),
    pendingObjects: v.number(),
    pendingBytes: v.number(),
  }).index('by_project_and_shard', ['projectId', 'shard']),
  /** The same counters summed over every project an account owns, added in roll-ups. */
  accountStorageUsage: defineTable({
    account: v.string(),
    objects: v.number(),
    bytes: v.number(),
  }).index('by_account', ['account']),
};
