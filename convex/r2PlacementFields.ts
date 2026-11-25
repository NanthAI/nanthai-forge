// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
/** Where an archive or object's bytes live: always R2. Absent until a row is reserved a key. */
export const r2PlacementFields = {
  location: v.optional(v.literal('r2')),
  r2Key: v.optional(v.string()),
  r2Committed: v.optional(v.boolean()),
};
