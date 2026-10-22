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
export const objectDocument = v.object({
  _id: v.id('projectObjects'),
  _creationTime: v.number(),
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
};
