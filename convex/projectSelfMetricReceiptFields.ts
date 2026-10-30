// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** Append-only metric evidence, one row per idempotency key. The earliest row of a
 * kind is that metric's collection start. Never read on an idle path. */
export const selfMetricReceiptTables = {
  projectSelfMetricReceipts: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    kind: v.union(v.literal('outcome'), v.literal('delivery'), v.literal('mutation')),
    actor: v.string(),
    at: v.string(),
    value: v.string(),
  })
    .index('by_project_and_key', ['projectId', 'key'])
    .index('by_project_and_at', ['projectId', 'at'])
    .index('by_project_and_kind_and_at', ['projectId', 'kind', 'at']),
};
