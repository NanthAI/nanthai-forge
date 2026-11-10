// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedKind = v.union(
  v.literal('intent'),
  v.literal('lane'),
  v.literal('save'),
  v.literal('candidate'),
  v.literal('job'),
  v.literal('issue'),
  v.literal('comment'),
  v.literal('lifecycle'),
);
export const hostedRef = v.object({
  kind: hostedKind,
  key: v.string(),
  version: v.number(),
  digest: v.string(),
  bytes: v.number(),
});
const identity = { projectId: v.id('hostedProjects'), kind: hostedKind, key: v.string() };
const indexed = {
  parent: v.string(),
  status: v.string(),
  version: v.number(),
  ownerOnly: v.optional(v.boolean()),
  /** Lane owner pin, mirrored from the record so reads never open bodies. */
  pinned: v.optional(v.boolean()),
};
export const hostedRecordFields = {
  ...identity,
  ...indexed,
  inline: v.optional(v.string()),
  bodyId: v.id('projectHostedRecordBodies'),
  /** Server-written Candidate creator, independent of its check requester. */
  creatorAccountId: v.optional(v.string()),
  /** Epoch of the authenticated input aggregate retained for clean and conflicted Candidates. */
  provenanceEpoch: v.optional(v.number()),
  restoreBases: v.optional(v.string()),
  digest: v.string(),
  bytes: v.number(),
  /** Canonical journal-row hash for digest-only Work migration comparisons. */
  workReadDigest: v.optional(v.string()),
  lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
};
export const hostedRecordTables = {
  projectHostedRecordBodies: defineTable({
    projectId: v.id('hostedProjects'),
    value: v.string(),
    operationId: v.optional(v.string()),
    request: v.optional(v.string()),
    revision: v.optional(v.number()),
    actor: v.optional(v.string()),
    at: v.optional(v.string()),
    command: v.optional(v.string()),
    baseBackupId: v.optional(v.id('projectBackups')),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_revision', ['projectId', 'revision'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
  // Canonical immutable versions; the head is only a per-resource CAS pointer.
  projectHostedRecords: defineTable(hostedRecordFields)
    .index('by_project_and_kind', ['projectId', 'kind'])
    .index('by_project_and_kind_and_key_and_version', ['projectId', 'kind', 'key', 'version'])
    .index('by_project_and_kind_and_key_and_version_and_plan', [
      'projectId',
      'kind',
      'key',
      'version',
      'lifecyclePlanId',
    ])
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    .index('by_project', ['projectId']),
  projectHostedRecordHeads: defineTable({
    ...identity,
    ...indexed,
    recordId: v.id('projectHostedRecords'),
    /** Work store kinds (issue, comment, lifecycle): the current version as its journal row read, so a
     * planning page reads one document per row. Absent on other kinds; a replace without it drops it. */
    value: v.optional(v.string()),
  })
    // Creation order within a kind: the Work store's planning list pages in the journal's append order.
    .index('by_project_and_kind', ['projectId', 'kind'])
    .index('by_project_and_kind_and_key', ['projectId', 'kind', 'key'])
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    // An Issue's comments or its Intent's notes, without reading the other.
    .index('by_project_and_kind_and_parent_and_status', ['projectId', 'kind', 'parent', 'status'])
    .index('by_project_and_kind_and_status', ['projectId', 'kind', 'status'])
    .index('by_project', ['projectId']),
  projectHostedOperations: defineTable({
    recovery: v.optional(v.string()),
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    metricAction: v.optional(
      v.union(
        v.literal('cancel'),
        v.literal('prioritize'),
        v.literal('revert'),
        v.literal('abandon'),
        v.literal('reopen'),
        v.literal('set-policy'),
        v.literal('accept'),
      ),
    ),
    /** Agent or person who started the counted command (metric 5.5), from the signed-in identity. */
    metricActorKind: v.optional(v.union(v.literal('agent'), v.literal('person'))),
    // Legacy cancel receipts; new successful commands append projectSelfMetricReceipts.
    metricMutation: v.optional(
      v.object({ action: v.literal('cancel'), actor: v.string(), operationId: v.string(), at: v.string() }),
    ),
    value: v.string(),
  })
    .index('by_project_and_metric_action', ['projectId', 'metricMutation.action'])
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId']),
};
