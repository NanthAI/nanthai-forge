// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
export const derivedFields = {
  original: v.string(),
  kind: v.string(),
  pin: v.string(),
  originalDigest: v.string(),
  originalSize: v.number(),
  digest: v.string(),
  size: v.number(),
  contentType: v.string(),
  storageId: v.optional(v.string()),
  inline: v.optional(v.string()),
  uploadType: v.optional(v.string()),
  removed: v.boolean(),
};
