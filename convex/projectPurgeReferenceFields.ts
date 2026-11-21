// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';

export const r2Sections = ['objectKeys', 'backupKeys', 'proposalKeys', 'uploadKeys', 'artifactKeys'] as const;

export const r2ReferencePosition = v.object({
  section: v.union(...r2Sections.map(section => v.literal(section))),
  cursor: v.union(v.string(), v.null()),
  side: v.optional(v.union(v.literal('lt'), v.literal('gt'))),
  single: v.optional(v.literal(true)),
});
