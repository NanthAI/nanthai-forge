// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
export const saveFailureView = v.object({
  operationId: v.string(),
  attemptId: v.string(),
  code: v.string(),
  at: v.number(),
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
  /** Trusted source-worker output; byte bodies remain in R2. */
  candidateFiles: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  digest: v.string(),
  bytes: v.number(),
  /** Canonical journal-row hash for digest-only Work migration comparisons. */
  workReadDigest: v.optional(v.string()),
  journalReady: v.optional(v.boolean()),
  journalReadyAt: v.optional(v.number()),
  journalSegment: v.optional(v.string()),
  journalLane: v.optional(
    v.object({
      head: v.string(),
      sourceVersion: v.number(),
      lifecycleVersion: v.number(),
      revert: v.boolean(),
      holderActor: v.optional(v.string()),
    }),
  ),
  lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
  /** A purged issue, comment or Intent version (Item 4c9e961e): the purge operation id. Header and digest stay, the
   * body goes; hostedRecordBody answers PLANNING_ITEM_PURGED for it, never a digest failure. */
  purged: v.optional(v.string()),
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
    journalSegment: v.optional(v.string()),
    journalCommand: v.optional(v.string()),
    /** Purged journal row (Item 4c9e961e): the purge operation id. Like an archived row it keeps its envelope and
     * `journalCommand` facts (its own command, every word replaced) and has no `command`; unlike one it has no
     * segment, so its words are nowhere. */
    purged: v.optional(v.string()),
    baseBackupId: v.optional(v.id('projectBackups')),
  })
    .index('by_project_and_revision', ['projectId', 'revision'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
  // Canonical immutable versions; the head is only a per-resource CAS pointer.
  projectHostedRecords: defineTable(hostedRecordFields)
    .index('by_project_and_journal_ready_at', ['projectId', 'journalReadyAt'])
    .index('by_project_and_body', ['projectId', 'bodyId'])
    // index-order: caller: convex/projectSelfMetrics.ts#page; order: Lane and save metrics bound _creationTime within each kind.
    .index('by_project_and_kind', ['projectId', 'kind'])
    .index('by_project_and_kind_and_key_and_version_and_plan', [
      'projectId',
      'kind',
      'key',
      'version',
      'lifecyclePlanId',
    ])
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    // index-order: caller: convex/projectJournalSelect.ts#selectJournal; order: existing-record scan persists creation-time index keys in the journal continuation cursor.
    .index('by_project', ['projectId']),
  projectHostedRecordHeads: defineTable({
    ...identity,
    ...indexed,
    recordId: v.id('projectHostedRecords'),
    /** Transient projection of the latest background save's retained terminal failure. */
    saveFailure: v.optional(
      v.object({
        ...saveFailureView.fields,
        actor: v.string(),
        boardRowId: v.id('projectFinishReadRows'),
        overlapRowId: v.optional(v.id('projectHostedOverlapLanes')),
      }),
    ),
    /** The Item this Intent or Lane serves. Empty means explicitly independent; absent is unprojected. */
    planningItemId: v.optional(v.string()),
    /** Work store kinds (issue, comment, lifecycle): the current version as its journal row read, so a
     * planning page reads one document per row. Absent on other kinds; a replace without it drops it. */
    value: v.optional(v.string()),
    /** Optional, version-pinned status timestamps for Work-store Items. */
    planningTimes: v.optional(
      v.object({
        version: v.number(),
        lastStatusChangeAt: v.union(v.string(), v.null()),
        closedAt: v.union(v.string(), v.null()),
        closeKept: v.union(v.string(), v.null()),
      }),
    ),
  })
    // Creation order within a kind: the Work store's planning list pages in the journal's append order.
    // index-order: caller: convex/projectWorkStore.ts#journalWorkStoreCompare; order: planning comparison exposes newest-first creation-time pages of Issues.
    .index('by_project_and_kind', ['projectId', 'kind'])
    .index('by_project_and_kind_and_key', ['projectId', 'kind', 'key'])
    .index('by_project_and_kind_and_item', ['projectId', 'kind', 'planningItemId'])
    // index-order: caller: convex/projectHostedDormancy.ts#landedByReceipt; order: receipt discovery selects the newest Candidate by creation time within an Intent.
    .index('by_project_and_kind_and_parent', ['projectId', 'kind', 'parent'])
    // An Issue's comments or its Intent's notes, without reading the other.
    .index('by_project_and_kind_and_parent_and_status', ['projectId', 'kind', 'parent', 'status'])
    .index('by_project_and_kind_and_status', ['projectId', 'kind', 'status']),
  projectHostedOperations: defineTable({
    planningApply: v.optional(v.string()),
    planningUndoneBy: v.optional(v.string()),
    recovery: v.optional(v.string()),
    journalDigest: v.optional(v.string()),
    journalReady: v.optional(v.boolean()),
    journalReadyAt: v.optional(v.number()),
    journalSegment: v.optional(v.string()),
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
    // index-order: caller: convex/projectJournalSelect.ts#selectJournal; order: existing-operation scan persists creation-time index keys in the journal continuation cursor.
    .index('by_project', ['projectId'])
    .index('by_project_and_journal_ready_at', ['projectId', 'journalReadyAt'])
    .index('by_project_and_metric_action', ['projectId', 'metricMutation.action'])
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId']),
};
