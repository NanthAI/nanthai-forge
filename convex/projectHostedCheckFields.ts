// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

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
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    candidateId: v.string(),
    machineId: v.optional(v.string()),
    status: v.string(),
    value: v.string(),
  })
    .index('by_run', ['runId'])
    .index('by_project_and_run', ['projectId', 'runId'])
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
