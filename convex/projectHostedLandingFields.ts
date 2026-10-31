// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const alarm = v.optional(
  v.union(v.object({ taskId: v.id('_scheduled_functions'), lastProgressAt: v.string() }), v.null()),
);
const phase = v.union(
  v.literal('queued'),
  v.literal('checking'),
  v.literal('ready'),
  v.literal('terminal-failed'),
  v.literal('landed'),
);
const lease = v.object({
  owner: v.string(),
  token: v.number(),
  until: v.number(),
  submissionId: v.string(),
  attemptId: v.string(),
});
export const hostedLandingTables = {
  projectHostedLandingBatches: defineTable({
    projectId: v.id('hostedProjects'),
    batchId: v.string(),
    composeOperationId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_batch', ['projectId', 'batchId'])
    .index('by_project_and_compose', ['projectId', 'composeOperationId']),
  projectHostedLandingDesired: defineTable({
    alarm,
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    submissionId: v.string(),
    composeOperationId: v.string(),
    selectionKey: v.string(),
    request: v.string(),
    value: v.string(),
    wake: v.union(v.object({ id: v.string(), taskId: v.id('_scheduled_functions') }), v.null()),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_selection', ['projectId', 'selectionKey'])
    .index('by_project_and_compose', ['projectId', 'composeOperationId']),
  projectHostedLandingAliases: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    requestHash: v.string(),
    submissionId: v.string(),
  }).index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId']),
  projectHostedLandingObservations: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    version: v.number(),
    value: v.string(),
  }).index('by_project_and_submission_and_version', ['projectId', 'submissionId', 'version']),
  projectHostedLandingCheckWakes: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    wake: v.union(v.object({ taskId: v.id('_scheduled_functions'), id: v.string() }), v.null()),
  }).index('by_project_and_run', ['projectId', 'runId']),
  projectHostedLandingQueues: defineTable({
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    sequence: v.number(),
    train: v.optional(v.array(v.string())),
    fence: v.number(),
    wake: v.union(
      v.object({ taskId: v.id('_scheduled_functions'), id: v.string(), at: v.number() }),
      v.null(),
    ),
    lease: v.union(lease, v.null()),
    /** Recent cohort outcomes for sizing (`1` passed, `0` a test failed), newest last. */
    checkHistory: v.optional(v.object({ first: v.optional(v.string()), admitted: v.optional(v.string()) })),
  }).index('by_project_and_channel', ['projectId', 'channel']),
  projectHostedLandingRequests: defineTable({
    alarm,
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    submissionId: v.string(),
    operationId: v.string(),
    candidateId: v.optional(v.string()),
    batchSelection: v.optional(v.string()),
    batchable: v.optional(v.boolean()),
    /** Server-only admission run of this submission's own Candidate (not in the state body). */
    admission: v.optional(
      v.object({
        runId: v.string(),
        status: v.union(
          v.literal('checking'),
          v.literal('passed'),
          v.literal('failed'),
          v.literal('unavailable'),
        ),
        endedAt: v.optional(v.number()),
      }),
    ),
    admitting: v.optional(v.literal(true)),
    revertOf: v.optional(v.string()),
    actor: v.string(),
    sequence: v.number(),
    priority: v.optional(v.union(v.literal('urgent'), v.literal('normal'))),
    priorityReason: v.optional(v.string()),
    priorityVersion: v.optional(v.number()),
    priorityChange: v.optional(
      v.object({
        operationId: v.string(),
        actor: v.string(),
        priority: v.union(v.literal('urgent'), v.literal('normal')),
        expectedVersion: v.number(),
      }),
    ),
    selectionKey: v.optional(v.string()),
    hold: v.optional(v.literal('main-red')),
    runnable: v.boolean(),
    phase,
    runId: v.union(v.string(), v.null()),
    attemptId: v.string(),
    value: v.string(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_hold', ['projectId', 'hold'])
    .index('by_project_and_revert_and_sequence', ['projectId', 'revertOf', 'sequence'])
    .index('by_project_and_candidate_and_sequence', ['projectId', 'candidateId', 'sequence'])
    .index('by_project_and_candidate_and_phase_and_sequence', [
      'projectId',
      'candidateId',
      'phase',
      'sequence',
    ])
    .index('by_project_and_selection', ['projectId', 'selectionKey'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_channel_and_runnable_and_priority_and_sequence', [
      'projectId',
      'channel',
      'runnable',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_phase_and_priority_and_sequence', [
      'projectId',
      'channel',
      'phase',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_runnable_and_sequence', [
      'projectId',
      'channel',
      'runnable',
      'sequence',
    ])
    .index('by_project_channel_runnable_batchable_priority_sequence', [
      'projectId',
      'channel',
      'runnable',
      'batchable',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_batchable_and_phase_and_sequence', [
      'projectId',
      'channel',
      'batchable',
      'phase',
      'sequence',
    ])
    .index('by_project_and_channel_and_phase_and_sequence', ['projectId', 'channel', 'phase', 'sequence'])
    .index('by_project_and_channel_and_sequence', ['projectId', 'channel', 'sequence'])
    .index('by_project_and_channel_and_admitting_and_sequence', [
      'projectId',
      'channel',
      'admitting',
      'sequence',
    ])
    .index('by_project_and_run_and_phase', ['projectId', 'runId', 'phase']),
  projectHostedLandingAttempts: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    attemptId: v.string(),
    number: v.number(),
    progress: v.optional(v.string()),
    value: v.string(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_attempt', ['projectId', 'attemptId'])
    .index('by_project_and_submission_and_number', ['projectId', 'submissionId', 'number']),
};
