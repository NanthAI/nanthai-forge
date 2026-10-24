// SPDX-License-Identifier: Apache-2.0
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
};
export const artifactBlobTables = {
  artifactBlobs: defineTable(artifactBlobFields).index('by_namespace_and_digest', ['namespace', 'digest']),
};
export const artifactBlobId = (ref: string) =>
  ref.startsWith('r2blob:') ? (ref.slice(7) as import('./_generated/dataModel').Id<'artifactBlobs'>) : null;
