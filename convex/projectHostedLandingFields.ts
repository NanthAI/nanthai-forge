// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
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
    fence: v.number(),
    wake: v.union(
      v.object({ taskId: v.id('_scheduled_functions'), id: v.string(), at: v.number() }),
      v.null(),
    ),
    lease: v.union(lease, v.null()),
  }).index('by_project_and_channel', ['projectId', 'channel']),
  projectHostedLandingRequests: defineTable({
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    submissionId: v.string(),
    operationId: v.string(),
    candidateId: v.optional(v.string()),
    revertOf: v.optional(v.string()),
    actor: v.string(),
    sequence: v.number(),
    runnable: v.boolean(),
    phase,
    runId: v.union(v.string(), v.null()),
    attemptId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_revert_and_sequence', ['projectId', 'revertOf', 'sequence'])
    .index('by_project_and_candidate_and_sequence', ['projectId', 'candidateId', 'sequence'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_channel_and_runnable_and_sequence', [
      'projectId',
      'channel',
      'runnable',
      'sequence',
    ])
    .index('by_project_and_channel_and_phase_and_sequence', ['projectId', 'channel', 'phase', 'sequence'])
    .index('by_project_and_channel_and_sequence', ['projectId', 'channel', 'sequence'])
    .index('by_project_and_run_and_phase', ['projectId', 'runId', 'phase']),
  projectHostedLandingAttempts: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    attemptId: v.string(),
    number: v.number(),
    progress: v.optional(v.string()),
    value: v.string(),
  })
    .index('by_project_and_attempt', ['projectId', 'attemptId'])
    .index('by_project_and_submission_and_number', ['projectId', 'submissionId', 'number']),
};
