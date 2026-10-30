// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const sourceOutput = v.object({
  sha256: v.string(),
  size: v.number(),
  storageId: v.optional(v.id('_storage')),
  r2Key: v.optional(v.string()),
  recipe: v.optional(v.object({ sha256: v.string(), size: v.number() })),
});
export const sourceTaskData = v.object({ id: v.string(), sha256: v.string() });
export const sourceStepTables = {
  projectSourceSteps: defineTable({
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    dispatch: v.string(),
    executionId: v.string(),
    scheduledId: v.optional(v.id('_scheduled_functions')),
    step: v.number(),
    cursor: v.union(v.string(), v.null()),
    batchId: v.optional(v.id('projectSourceBatches')),
  }).index('by_project_and_job', ['projectId', 'jobId']),
  projectSourceBatches: defineTable({
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    kind: v.string(),
    end: v.number(),
    total: v.number(),
    next: v.number(),
    completed: v.number(),
    status: v.union(v.literal('queued'), v.literal('waiting'), v.literal('done'), v.literal('fenced')),
    failure: v.union(v.string(), v.null()),
  })
    .index('by_status', ['status'])
    .index('by_project_and_job_and_step', ['projectId', 'jobId', 'step']),
  projectSourceTasks: defineTable({
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    batchId: v.id('projectSourceBatches'),
    index: v.number(),
    input: v.string(),
    status: v.union(v.literal('queued'), v.literal('running'), v.literal('done')),
    generation: v.number(),
    scheduledId: v.optional(v.id('_scheduled_functions')),
    progress: v.union(sourceTaskData, v.null()),
    output: v.union(sourceTaskData, v.null()),
    failure: v.union(v.string(), v.null()),
  }).index('by_batch_and_index', ['batchId', 'index']),
  projectSourcePools: defineTable({
    key: v.literal('source'),
    active: v.array(v.id('projectSourceTasks')),
    drainQueued: v.optional(v.boolean()),
  }).index('by_key', ['key']),
};
