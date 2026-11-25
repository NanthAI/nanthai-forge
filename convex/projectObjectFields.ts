// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { r2PlacementFields } from './r2PlacementFields';
/** The only writers that may copy an immutable catalog or point entry into its own row, one label
 * each: they change trusted State metadata, rebind the stored encoding, or mark a purge tombstone.
 * Flag-only and id-only writers never copy (guarded by tests/object-row-reasons.test.mjs). */
export const objectRowReasons = [
  'source-output-encoding',
  'source-output-state',
  'source-state-size',
  'state-generation',
  'recovery-encoding',
  'purge-tombstone',
] as const;
export type ObjectRowReason = (typeof objectRowReasons)[number];
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
  nonce: v.string(),
  ...r2PlacementFields,
  r2SweepKey: v.optional(v.string()),
  /** A pending reservation whose ID is private to a catalog seed upload. */
  seedOperationId: v.optional(v.string()),
  r2PreparedAt: v.optional(v.number()),
  recipeClosure: v.optional(recipeClosure),
  recipe: v.optional(v.object({ digest: v.string(), size: v.number() })),
  pack: v.optional(objectPack),
  /** A pending upload pack (feature upload-packs): its members in byte order. Member rows are
   * written only by the commit that read the pack and checked each member digest; then this is
   * cleared. */
  packMembers: v.optional(v.array(v.object({ digest: v.string(), size: v.number() }))),
  removed: v.boolean(),
  /** Owner purge of a leaked save (Item 9d3c407d): bytes deleted, every lookup refuses PURGED. */
  purged: v.optional(v.object({ at: v.number(), operationId: v.string() })),
  sourceReferenced: v.optional(v.boolean()),
  /** Which writer had `objectRow` copy a catalog or point entry into this row (Item d0297b9f), so
   * dogfood counts materializations per writer from the rows themselves. Absent on
   * rows a writer created directly and on copies made before the stamp. */
  materializedBy: v.optional(v.union(...objectRowReasons.map(reason => v.literal(reason)))),
};
/** Readable bytes exist: a recipe, or an R2 object a HEAD check confirmed. */
export const isStored = (row: { recipe?: unknown; location?: string; r2Committed?: boolean }) =>
  !!(row.recipe || (row.location === 'r2' && row.r2Committed));
/** A committed object in R2 (as opposed to a recipe). */
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
    stateGeneration: v.optional(v.number()),
    stateSize: v.optional(stateSize),
    /** Complete immutable source point or original-upload binding. */
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
    // Purge reference proof by key prefix (Item 411727ba, convex/projectPurgeReferences.ts).
    .index('by_r2Key', ['r2Key']),
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
