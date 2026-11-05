// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
export const cleanupPin = v.object({
  storageId: v.id('_storage'),
  digest: v.string(),
  size: v.number(),
  // Class 4 has no R2 copy: allowed only with an owner-approved manifest digest, no keys and no owners.
  class: v.union(v.literal(1), v.literal(2), v.literal(3), v.literal(4)),
  verifiedAt: v.string(),
  recheckedAt: v.string(),
  fullDigest: v.literal(true),
  keys: v.array(v.string()),
  owners: v.array(
    v.object({ table: v.union(v.literal('projectObjects'), v.literal('projectBackups')), id: v.string() }),
  ),
});
export const cleanupResult = v.object({
  deleted: v.number(),
  bytes: v.number(),
  excluded: v.array(v.object({ storageId: v.string(), code: v.string() })),
  changedRows: v.number(),
});
