// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { defineTable } from 'convex/server';
export const autonomyPolicy = v.object({
  checkLogs: v.optional(v.object({ uploadLocal: v.boolean(), retentionDays: v.number() })),
  autoExchange: v.optional(
    v.object({
      enabled: v.boolean(),
      debounceMs: v.number(),
      maxPendingAgeMs: v.number(),
      pauseOnDailySpend: v.optional(v.boolean()),
    }),
  ),
  trust: v.optional(
    v.object({
      enabled: v.boolean(),
      trustedAt: v.optional(v.number()),
      autonomousAt: v.optional(v.number()),
      halfLifeDays: v.optional(v.number()),
      culpritKeep: v.optional(v.number()),
      probationLandings: v.optional(v.number()),
      vendors: v.optional(v.record(v.string(), v.string())),
      establishedVendors: v.optional(v.array(v.string())),
    }),
  ),
  preset: v.union(
    v.literal('supervised'),
    v.literal('trusted'),
    v.literal('autonomous'),
    v.literal('custom'),
  ),
  acceptance: v.object({
    mode: v.union(v.literal('review'), v.literal('auto-on-pass')),
    gate: v.optional(v.union(v.literal('full'), v.literal('contract'))),
    disjointFastPath: v.optional(v.boolean()),
    hostedCrossHeadReuse: v.optional(v.boolean()),
    scopedRecheck: v.optional(v.boolean()),
    landing: v.optional(v.union(v.literal('batched'), v.literal('optimistic'))),
    batchWindowMs: v.optional(v.number()),
    autoActors: v.optional(v.array(v.string())),
    protectedPaths: v.array(v.string()),
    ownerApprovalPaths: v.optional(v.array(v.string())),
  }),
  checks: v.optional(
    v.object({
      // Persisted Modal policies remain readable; editedPolicy rejects new selection.
      runner: v.union(v.literal('local'), v.literal('modal'), v.literal('github-actions')),
      repo: v.optional(v.string()),
      runsOn: v.optional(v.string()),
      shards: v.optional(v.number()),
      credentialsRef: v.optional(
        v.union(
          v.object({ kind: v.literal('env'), tokenId: v.string(), tokenSecret: v.string() }),
          v.object({ kind: v.literal('file'), path: v.string() }),
        ),
      ),
      ratesUsdPerMinute: v.optional(v.record(v.string(), v.number())),
      concurrency: v.optional(v.number()),
      fallback: v.optional(v.union(v.literal('manual'), v.literal('local'))),
    }),
  ),
  integrationPreview: v.optional(v.object({ auto: v.boolean() })),
  ownerRootUpdates: v.optional(v.boolean()),
  autoSnapshot: v.optional(v.boolean()),
  laneUpdates: v.union(v.literal('auto'), v.literal('ask')),
  lifecycle: v.object({ completeOnAccept: v.boolean(), cleanRegenerableCopies: v.boolean() }),
  notify: v.object({ awaySummary: v.boolean() }),
  githubMirror: v.optional(v.object({ repo: v.string(), autoPush: v.boolean(), laneRefs: v.literal(false) })),
});
export const automaticAction = v.object({
  actor: v.string(),
  summary: v.string(),
  undo: v.string(),
  runId: v.optional(v.string()),
  policy: v.optional(autonomyPolicy),
});
export const acceptanceEvidence = v.object({
  policy: autonomyPolicy,
  paths: v.union(v.array(v.string()), v.null()),
  automatic: v.optional(automaticAction),
  /** Actual source ancestry was checked in the action, not inferred from a graph. */
  containsPrevious: v.boolean(),
});
export const autonomyTables = {
  projectPolicyChanges: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    actor: v.string(),
    request: v.string(),
    at: v.string(),
    previous: autonomyPolicy,
    policy: autonomyPolicy,
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
