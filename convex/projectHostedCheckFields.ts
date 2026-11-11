// SPDX-License-Identifier: Apache-2.0
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
    .index('by_project_and_kind', ['projectId', 'kind']),
  projectHostedCheckSettingVersions: defineTable(setting).index('by_project_and_kind_and_key_and_version', [
    'projectId',
    'kind',
    'key',
    'version',
  ]),
  projectHostedCheckRuns: defineTable({
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
    reportStorage: v.optional(v.literal('r2')),
    resultBatch: v.optional(v.object({ packed: v.boolean() })),
    reportTimingStamp: v.optional(v.object({ generation: v.string(), sequence: v.number() })),
    reportTimingComplete: v.optional(v.boolean()),
    reportTimingParts: v.optional(v.array(v.string())),
    reportConclusion: v.optional(v.string()),
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
    .index('by_project_and_run', ['projectId', 'runId']),
};
