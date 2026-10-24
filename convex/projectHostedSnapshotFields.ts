// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { hostedKind, hostedRef } from './projectHostedRecordFields';
export const snapshotPlan = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  operationId: v.string(),
  snapshotId: v.string(),
  authorityEpoch: v.number(),
  expectedSnapshotId: v.union(v.string(), v.null()),
  journalSequence: v.number(),
  seedCheckpoint: v.object({ sha256: v.string(), size: v.number() }),
  source: v.object({ head: v.string(), receiptId: v.string() }),
  pageCount: v.number(),
  recordCount: v.number(),
  root: v.string(),
};
export const snapshotFields = {
  ...snapshotPlan,
  request: v.string(),
  at: v.number(),
  nextPage: v.number(),
  stagedRecords: v.number(),
  stagedRoot: v.string(),
  lastKey: v.union(v.string(), v.null()),
  status: v.union(v.literal('staging'), v.literal('published')),
};
export const snapshotDocument = v.object({
  _id: v.id('projectHostedSnapshots'),
  _creationTime: v.number(),
  ...snapshotFields,
});
export const snapshotProgress = v.object({
  snapshotId: v.string(),
  nextPage: v.number(),
  stagedRecords: v.number(),
  stagedRoot: v.string(),
  status: v.union(v.literal('staging'), v.literal('published')),
});
export const snapshotPageReceipt = v.object({ page: v.number(), root: v.string(), records: v.number() });
export const hostedSnapshotTables = {
  projectHostedSnapshots: defineTable(snapshotFields)
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_snapshot', ['projectId', 'snapshotId']),
  projectHostedSnapshotPages: defineTable({
    projectId: v.id('hostedProjects'),
    snapshotId: v.id('projectHostedSnapshots'),
    page: v.number(),
    root: v.string(),
    previousRoot: v.string(),
    refs: v.array(hostedRef),
  }).index('by_snapshot_and_page', ['snapshotId', 'page']),
  // Recovery/export selection only. This never selects a Channel or a Lane head.
  projectHostedSnapshotHeads: defineTable({
    projectId: v.id('hostedProjects'),
    snapshotId: v.id('projectHostedSnapshots'),
    key: v.string(),
    journalSequence: v.number(),
  }).index('by_project', ['projectId']),
  projectHostedDisplayRecords: defineTable({
    projectId: v.id('hostedProjects'),
    snapshotId: v.id('projectHostedSnapshots'),
    kind: hostedKind,
    key: v.string(),
    version: v.number(),
    parent: v.string(),
    status: v.string(),
    value: v.string(),
  })
    .index('by_snapshot_and_kind_and_key_and_version', ['snapshotId', 'kind', 'key', 'version'])
    .index('by_snapshot_and_kind_and_parent', ['snapshotId', 'kind', 'parent'])
    .index('by_project', ['projectId']),
};
