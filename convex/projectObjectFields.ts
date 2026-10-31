// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { backfillFields } from './r2BackfillFields';
export const objectFields = {
  projectId: v.id('hostedProjects'),
  digest: v.string(),
  size: v.number(),
  nonce: v.string(),
  storageId: v.optional(v.id('_storage')),
  ...backfillFields,
  r2SweepKey: v.optional(v.string()),
  r2PreparedAt: v.optional(v.number()),
  recipe: v.optional(v.object({ digest: v.string(), size: v.number() })),
  removed: v.boolean(),
  sourceReferenced: v.optional(v.boolean()),
};
/** Readable bytes exist: Convex storage, a recipe, or an R2 object a HEAD check confirmed. */
export const isStored = (row: {
  storageId?: unknown;
  recipe?: unknown;
  location?: string;
  r2Committed?: boolean;
}) => !!(row.storageId || row.recipe || (row.location === 'r2' && row.r2Committed));
/** A committed object in R2 (as opposed to Convex storage or a recipe). */
export const isR2Object = (row: { location?: string; r2Committed?: boolean; r2Key?: string }) =>
  row.location === 'r2' && !!row.r2Committed && !!row.r2Key;
/** A stored object as resolved: its row, or a catalog entry (no `_id`). */
export const objectDocument = v.object({
  _id: v.optional(v.id('projectObjects')),
  _creationTime: v.optional(v.number()),
  ...objectFields,
});
export const objectTables = {
  projectObjects: defineTable(objectFields)
    .index('by_project', ['projectId'])
    .index('by_project_and_digest', ['projectId', 'digest'])
    .index('by_project_and_removed', ['projectId', 'removed'])
    .index('by_digest_and_removed', ['digest', 'removed'])
    .index('by_storage', ['storageId'])
    .index('by_nonce', ['nonce']),
  /** Sorted, immutable object catalog pages: one row per `objectCatalogPage`
   * stored objects instead of one row per object (GitHub import). */
  projectObjectCatalog: defineTable({
    projectId: v.id('hostedProjects'),
    first: v.string(),
    last: v.string(),
    /** Concatenated 64-hex digests, ascending. */
    digests: v.string(),
    sizes: v.array(v.number()),
    /** Logical objects stored as a recipe (no raw bytes of their own). */
    recipes: v.array(v.object({ index: v.number(), digest: v.string(), size: v.number() })),
    origin: v.string(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_first', ['projectId', 'first']),
};
