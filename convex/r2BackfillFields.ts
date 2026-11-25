// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
/** Markers an earlier move of Convex files to R2 left on old rows; nothing writes or reads them now. */
export const backfillFields = {
  location: v.optional(v.union(v.literal('convex'), v.literal('r2'))),
  r2Key: v.optional(v.string()),
  r2Committed: v.optional(v.boolean()),
  r2ConvexPurged: v.optional(v.boolean()),
  r2BackfilledAt: v.optional(v.number()),
  r2BackfillOperationId: v.optional(v.string()),
};
