// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
export const landingCapsulePointer = v.object({
  protocol: v.literal(1),
  sha256: v.string(),
  size: v.number(),
  rawSize: v.number(),
  tablesDigest: v.optional(v.string()),
  version: v.number(),
  tables: v.string(),
  summary: v.optional(v.string()),
});
