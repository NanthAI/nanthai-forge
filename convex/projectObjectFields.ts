// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { backfillFields } from './r2BackfillFields';
export const objectPack = v.object({ digest: v.string(), size: v.number(), offset: v.number() });
// Trusted worker-only raw R2 leaves, including verified ranges in existing packs.
export const recipeClosure = v.array(
  v.object({ sha256: v.string(), size: v.number(), pack: v.optional(objectPack) }),
);
export const stateSize = v.object({ fileCount: v.number(), manifestBytes: v.number() });
export const stateSizes = v.optional(
  v.array(v.object({ index: v.number(), fileCount: v.number(), manifestBytes: v.number() })),
);
export const objectFields = {
  projectId: v.id('hostedProjects'),
  digest: v.string(),
  size: v.number(),
  /** Authenticated State topological level; absent on old rows and non-States. */
  stateGeneration: v.optional(v.number()),
  /** Logical dimensions of hash-verified State bytes; absent on legacy States. */
  stateSize: v.optional(stateSize),
  /** Exact parents of a hash-verified State (Git commit-graph parity), written once beside its
   * generation so ancestry walks read this row instead of the manifest. Absent on old rows. */
  stateParents: v.optional(v.array(v.string())),
  /** Trusted State-bound physical recipe root; absent until the writer is enabled. */
  statePhysical: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  /** Legacy, trees in packs (tried and dropped, docs/decisions.md): never written or read. Kept
   * as a tolerated field so a row written before the rollback still validates; remove once no
   * deployment holds one (the dev deployment's were stripped). */
  stateTree: v.optional(v.any()),
  nonce: v.string(),
  storageId: v.optional(v.id('_storage')),
  ...backfillFields,
  r2SweepKey: v.optional(v.string()),
  r2PreparedAt: v.optional(v.number()),
  recipeClosure: v.optional(recipeClosure),
  recipe: v.optional(v.object({ digest: v.string(), size: v.number() })),
  pack: v.optional(objectPack),
  /** A pending upload pack (feature upload-packs): its members in byte order. Member rows are
   * written only by the commit that read the pack and checked each member digest; then this is
   * cleared. */
  packMembers: v.optional(v.array(v.object({ digest: v.string(), size: v.number() }))),
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
  /** Original upload ids remain replayable after their descriptors move to catalog pages.
   * Values are digest pins; migration keys retain only their bounded cursor/byte receipt. */
  projectObjectReceipts: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    value: v.string(),
    nonce: v.optional(v.string()),
    size: v.optional(v.number()),
    /** Complete immutable source point binding; upload-id receipts keep their original shape. */
    sourceBinding: v.optional(
      v.union(
        v.object({ r2Key: v.string(), pack: v.optional(objectPack) }),
        v.object({ recipe: v.object({ digest: v.string(), size: v.number() }) }),
      ),
    ),
  })
    .index('by_key', ['key'])
    .index('by_project_and_nonce_and_value', ['projectId', 'nonce', 'value']),
  projectObjects: defineTable(objectFields)
    .index('by_project_and_digest', ['projectId', 'digest'])
    .index('by_project_and_removed', ['projectId', 'removed'])
    .index('by_digest_and_removed', ['digest', 'removed'])
    .index('by_storage', ['storageId'])
    .index('by_project_and_storage_and_removed', ['projectId', 'storageId', 'removed'])
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
    stateSizes,
    stateGenerations: v.optional(v.array(v.object({ index: v.number(), generation: v.number() }))),
    /** Logical objects stored as a recipe (no raw bytes of their own). */
    recipes: v.array(v.object({ index: v.number(), digest: v.string(), size: v.number() })),
    packs: v.optional(
      v.array(v.object({ index: v.number(), digest: v.string(), size: v.number(), offset: v.number() })),
    ),
    origin: v.string(),
  }).index('by_project_and_first', ['projectId', 'first']),
};
