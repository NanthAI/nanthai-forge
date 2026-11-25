// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { checkCause } from '../src/hosted-check';
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { checkGate } from './projectHostedMainAuditFields';

const setting = {
  projectId: v.id('hostedProjects'),
  kind: v.union(v.literal('definition'), v.literal('runner')),
  key: v.string(),
  version: v.number(),
  digest: v.string(),
  value: v.string(),
};
export const hostedCheckTables = {
  projectHostedTestTimings: defineTable({
    projectId: v.id('hostedProjects'),
    history: v.string(),
  }).index('by_project', ['projectId']),
  projectHostedActionsResults: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    index: v.number(),
    digest: v.string(),
    // Issue d0f8472a (convex/projectHostedActionsReports.ts): arrival order, raw shard reports until
    // the run is terminal, and on the progress row (index -1) the compact progress state.
    sequence: v.optional(v.number()),
    complete: v.optional(v.boolean()),
    reports: v.optional(v.string()),
    state: v.optional(v.string()),
  }).index('by_project_and_run_and_index', ['projectId', 'runId', 'index']),
  projectHostedCheckWorkers: defineTable({
    projectId: v.id('hostedProjects'),
    machineId: v.string(),
    revokedAt: v.optional(v.number()),
    sessionId: v.string(),
    actor: v.string(),
    configuration: v.string(),
    keyId: v.string(),
  }).index('by_project_and_machine', ['projectId', 'machineId']),
  projectHostedCheckSettings: defineTable(setting)
    .index('by_project_and_kind_and_key', ['projectId', 'kind', 'key'])
    // index-order: caller: convex/projectHostedCheckDefinitions.ts#list; order: check definition list exposes creation-time pagination cursors.
    .index('by_project_and_kind', ['projectId', 'kind']),
  projectHostedCheckSettingVersions: defineTable(setting).index('by_project_and_kind_and_key_and_version', [
    'projectId',
    'kind',
    'key',
    'version',
  ]),
  projectHostedCheckRuns: defineTable({
    cause: v.optional(v.union(...Object.values(checkCause).map(code => v.literal(code)))),
    /** First-check donor reuse evaluated. False retains the existing audit-baseline refusal. */
    auditDonor: v.optional(v.boolean()),
    auditCoverage: v.optional(v.string()),
    replayClock: v.optional(
      v.object({
        dispatchedAt: v.optional(v.number()),
        startedAt: v.optional(v.number()),
        endedAt: v.optional(v.number()),
      }),
    ),
    // Dispatch attribution and one idempotent late usage receipt; never acceptance evidence.
    cancelledUsage: v.optional(
      v.object({
        submissions: v.array(v.string()),
        pending: v.optional(v.literal(true)),
        corrected: v.optional(v.literal(true)),
        final: v.optional(
          v.object({ seconds: v.number(), receipt: v.object({ sha256: v.string(), size: v.number() }) }),
        ),
      }),
    ),
    metricsProjected: v.optional(v.literal(true)),
    metricProjection: v.optional(v.object({ rowId: v.id('projectFinishReadRows'), digest: v.string() })),
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    candidateId: v.string(),
    verdictKey: v.optional(v.string()),
    /** The exact mirror publication this CI run waits for; indexed, never polled. */
    ciMirrorJob: v.optional(v.id('projectGithubMirrorJobs')),
    /** Private cancellation fence; it never expands the client run schema. */
    ciCancel: v.optional(v.union(v.literal('queued'), v.literal('attempted'))),
    /** When the run's first test shard opened its session (the first after the plan), in ms;
     * server-only, written with keep-the-run on. Keep the run (fa2c1383) measures a run's progress
     * from here, so waiting for runners is not progress. */
    shardStartedAt: v.optional(v.number()),
    /** Latest main-move sweep verdict for this canonical run. Observation only. */
    mainMoveDecision: v.optional(
      v.object({
        action: v.union(v.literal('keep'), v.literal('cancel')),
        reason: v.string(),
        moverReceiptId: v.string(),
      }),
    ),
    reportStorage: v.optional(v.literal('r2')),
    /** The run-scoped immutable timing version, even for Actions recipes from older runners. */
    timingHistoryGeneration: v.optional(v.string()),
    machineSelection: v.optional(v.object({ sha256: v.string(), size: v.number() })),
    resultBatch: v.optional(v.object({ packed: v.boolean() })),
    reportTimingStamp: v.optional(v.object({ generation: v.string(), sequence: v.number() })),
    reportTimingComplete: v.optional(v.boolean()),
    reportTimingParts: v.optional(v.array(v.string())),
    reportConclusion: v.optional(v.union(v.string(), v.null())),
    // A checking stall schedules one recovery of the original report inbox.
    reportRecovery: v.optional(v.id('_scheduled_functions')),
    reportCollection: v.optional(
      v.object({
        token: v.string(),
        fence: v.number(),
        until: v.number(),
        scheduledFunctionId: v.optional(v.id('_scheduled_functions')),
      }),
    ),
    reportParts: v.optional(v.number()),
    reportDigest: v.optional(v.string()),
    reportFlakes: v.optional(v.string()),
    /** Optional proof metadata beside the run; immutable receipts never change. */
    proof: v.optional(v.string()),
    machineId: v.optional(v.string()),
    status: v.string(),
    value: v.string(),
    gate: v.optional(checkGate),
  })
    // index-order: caller: convex/projectMetricReadRuns.ts#metricRunsPage; order: metrics bound _creationTime before paging check runs.
    .index('by_project', ['projectId'])
    .index('by_project_and_metrics_projection', ['projectId', 'metricsProjected'])
    .index('by_ci_mirror_job', ['ciMirrorJob'])
    .index('by_run', ['runId'])
    .index('by_project_and_run', ['projectId', 'runId'])
    .index('by_project_and_verdict', ['projectId', 'verdictKey'])
    .index('by_project_and_candidate', ['projectId', 'candidateId'])
    .index('by_project_and_status', ['projectId', 'status'])
    .index('by_project_and_machine_and_status', ['projectId', 'machineId', 'status']),
  projectHostedCheckCallbacks: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    eventId: v.string(),
    digest: v.string(),
    value: v.string(),
  })
    .index('by_project_and_run_and_event', ['projectId', 'runId', 'eventId'])
    // index-order: caller: convex/projectHostedMainAuditState.ts#mainAuditStatus; order: audit selects the newest callback by creation time; expiry also bounds _creationTime.
    .index('by_project_and_run', ['projectId', 'runId']),
  projectHostedCheckShards: defineTable({
    resultDigest: v.optional(v.string()),
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    index: v.number(),
    attempt: v.number(),
    digest: v.string(),
    value: v.string(),
  })
    .index('by_project_and_run_and_index', ['projectId', 'runId', 'index'])
    // index-order: caller: convex/projectHostedCheckRead.ts#shards; order: shard list exposes creation-time pagination cursors.
    .index('by_project_and_run', ['projectId', 'runId']),
};
