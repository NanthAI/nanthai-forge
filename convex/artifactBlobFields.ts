// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { defineTable } from 'convex/server';
export const artifactBlobFields = {
  namespace: v.string(),
  digest: v.string(),
  size: v.number(),
  contentType: v.string(),
  r2Key: v.string(),
  committed: v.boolean(),
  removed: v.boolean(),
  /** A removed binding whose R2 bytes are not yet known gone (convex/artifactStorage.ts): retries so far, the
   * scheduled retry, and the time before which a successful delete is not final (an upload signed before the removal
   * can still land until then). All three are cleared once the bytes are gone. */
  deleteAttempts: v.optional(v.number()),
  deleteTask: v.optional(v.id('_scheduled_functions')),
  deleteAfter: v.optional(v.number()),
  /** When an upload was last signed for this binding after its reservation (convex/artifactStorage.ts). */
  signedAt: v.optional(v.number()),
};
export const artifactBlobTables = {
  artifactBlobs: defineTable(artifactBlobFields)
    .index('by_namespace_and_digest', ['namespace', 'digest'])
    .index('by_delete_attempts', ['deleteAttempts']),
};
export const artifactBlobId = (ref: string) =>
  ref.startsWith('r2blob:') ? (ref.slice(7) as import('./_generated/dataModel').Id<'artifactBlobs'>) : null;
