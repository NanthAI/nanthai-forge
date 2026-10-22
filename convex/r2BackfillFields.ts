// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
/** Optional on existing rows; Convex storage ids remain available for explicit recovery. */
export const backfillFields = {
  location: v.optional(v.union(v.literal('convex'), v.literal('r2'))),
  r2Key: v.optional(v.string()),
  r2Committed: v.optional(v.boolean()),
  r2ConvexPurged: v.optional(v.boolean()),
  r2BackfilledAt: v.optional(v.number()),
  r2BackfillOperationId: v.optional(v.string()),
};
export const backfillKind = v.union(
  v.literal('objects'),
  v.literal('backups'),
  v.literal('proposals'),
  v.literal('archives'),
);
export const backfillPin = v.object({
  kind: backfillKind,
  id: v.union(v.id('projectObjects'), v.id('projectBackups'), v.id('projectProposals')),
  storageId: v.id('_storage'),
  digest: v.string(),
  size: v.number(),
  location: v.union(v.literal('convex'), v.literal('r2'), v.null()),
});
