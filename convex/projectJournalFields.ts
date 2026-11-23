// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const planningArchiveIndexVersion = 2;
export const planningArchiveBackfillProgress = v.object({
  mode: v.union(v.literal('index'), v.literal('count')),
  legacyRecords: v.boolean(),
  cursor: v.union(v.string(), v.null()),
  pending: v.array(v.string()),
  rangeDone: v.boolean(),
  indexed: v.number(),
  expected: v.number(),
});

/** One compact index per immutable segment. Separate from hot finish projections so archive
 * range indexes never multiply the index footprint of every live landing row. */
export const journalTables = {
  projectJournalSegments: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    pageId: v.optional(v.string()),
    scope: v.string(),
    from: v.number(),
    through: v.number(),
    category: v.union(
      v.literal('record'),
      v.literal('events'),
      v.literal('operations'),
      v.literal('save'),
      v.literal('coordination'),
      v.literal('fragment'),
    ),
    recordKind: v.optional(v.string()),
    firstPosition: v.optional(v.string()),
    lastPosition: v.optional(v.string()),
    laneId: v.optional(v.string()),
    intentId: v.optional(v.string()),
    recipientActor: v.optional(v.string()),
    value: v.string(),
  })
    .index('by_project_and_page', ['projectId', 'pageId'])
    .index('by_project_and_key', ['projectId', 'key'])
    .index('by_project_and_scope_and_from', ['projectId', 'scope', 'from'])
    .index('by_project_and_record_kind_and_first', ['projectId', 'recordKind', 'firstPosition'])
    .index('by_project_and_category_and_last', ['projectId', 'category', 'lastPosition'])
    .index('by_project_and_category_and_first', ['projectId', 'category', 'firstPosition'])
    .index('by_project_and_lane_and_last', ['projectId', 'laneId', 'lastPosition'])
    .index('by_project_and_intent_and_last', ['projectId', 'intentId', 'lastPosition'])
    .index('by_project_and_recipient_and_last', ['projectId', 'recipientActor', 'lastPosition']),
};

/** Compact deduplication receipts for archived coordination detail. They retain no message
 * payload or source bytes. Messages/handoffs/acknowledgements remain in their original table. */
export const journalReceiptTables = {
  projectJournalReceipts: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    hash: v.string(),
    envelope: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
