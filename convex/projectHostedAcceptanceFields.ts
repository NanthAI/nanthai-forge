// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const identity = { projectId: v.id('hostedProjects'), receiptId: v.string() };
const pin = v.object({ sha256: v.string(), size: v.number() });
export const hostedAcceptanceTables = {
  projectHostedAcceptances: defineTable({
    ...identity,
    submissionId: v.string(),
    attemptId: v.string(),
    sequence: v.number(),
    value: v.string(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_sequence', ['projectId', 'sequence']),
  // These are immutable snapshot deltas, selected by the Channel CAS. H21 can
  // fold them into portable recovery snapshots without cloning all Work here.
  projectHostedAcceptanceSnapshots: defineTable({
    projectId: v.id('hostedProjects'),
    snapshotId: v.string(),
    previousId: v.string(),
    receiptId: v.string(),
    sourceRevision: v.number(),
    head: v.string(),
  }).index('by_project_and_snapshot', ['projectId', 'snapshotId']),
  projectHostedAcceptanceEvents: defineTable({
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    sequence: v.number(),
    value: v.string(),
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
  projectHostedAcceptancePlans: defineTable({
    ...identity,
    submissionId: v.string(),
    attemptId: v.string(),
    actor: v.string(),
    inputsNext: v.union(pin, v.null()),
    dependenciesNext: v.union(pin, v.null()),
    inputPages: v.number(),
    dependencyPages: v.number(),
    lanes: v.number(),
    root: v.string(),
    appliedPage: v.number(),
    appliedEntry: v.number(),
  }).index('by_project_and_receipt', ['projectId', 'receiptId']),
  projectHostedAcceptancePages: defineTable({
    ...identity,
    kind: v.union(v.literal('inputs'), v.literal('dependencies')),
    index: v.number(),
    digest: v.string(),
    root: v.string(),
    value: v.string(),
  }).index('by_project_and_receipt_and_kind_and_index', ['projectId', 'receiptId', 'kind', 'index']),
};
