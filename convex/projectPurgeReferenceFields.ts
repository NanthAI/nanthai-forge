// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';

export const r2Sections = [
  'objectKeys',
  'backupKeys',
  'archiveKeys',
  'proposalKeys',
  'uploadKeys',
  'artifactKeys',
] as const;

export const r2ReferencePosition = v.object({
  section: v.union(...r2Sections.map(section => v.literal(section))),
  cursor: v.union(v.string(), v.null()),
  /** Legacy, the per-side foreign scan before the key indexes: never written. A stored position
   * that has it restarts the scan. Remove once no purge chain can hold one. */
  side: v.optional(v.union(v.literal('lt'), v.literal('gt'))),
  single: v.optional(v.literal(true)),
});
