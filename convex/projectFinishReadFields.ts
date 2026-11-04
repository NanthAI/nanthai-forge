// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** Transactional read projections, never source bytes or controller state. */
export const finishReadTables = {
  projectFinishReadRows: defineTable({
    kind: v.string(),
    sourceId: v.string(),
    value: v.string(),
    projectId: v.optional(v.id('hostedProjects')),
    submissionId: v.optional(v.string()),
    operationId: v.optional(v.string()),
    actor: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    runId: v.optional(v.string()),
    channel: v.optional(v.string()),
  })
    .index('by_kind_and_source', ['kind', 'sourceId'])
    .index('by_kind_and_project_and_submission', ['kind', 'projectId', 'submissionId'])
    .index('by_kind_and_project_and_operation', ['kind', 'projectId', 'operationId'])
    .index('by_kind_and_project_and_actor_and_operation', ['kind', 'projectId', 'actor', 'operationId'])
    .index('by_kind_and_project_and_attempt', ['kind', 'projectId', 'attemptId'])
    .index('by_kind_and_project_and_run', ['kind', 'projectId', 'runId'])
    .index('by_kind_and_project_and_channel', ['kind', 'projectId', 'channel']),
};
