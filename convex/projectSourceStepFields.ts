// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { objectPack, recipeClosure, stateSize } from './projectObjectFields';
import { sourceExecutionTiming } from './projectSourceStepTiming';
import {
  sourceFailureStages,
  sourceFailureClasses,
  sourceFailureCodes,
  sourceFailureCalls,
} from '../src/hosted-source-retry';
export const sourceOutput = v.object({
  stateGeneration: v.optional(v.number()),
  stateSize: v.optional(stateSize),
  stateParents: v.optional(v.array(v.string())),
  statePhysical: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  statePhysicalRebind: v.optional(v.boolean()),
  sha256: v.string(),
  size: v.number(),
  storageId: v.optional(v.id('_storage')),
  r2Key: v.optional(v.string()),
  pack: v.optional(objectPack),
  physical: v.optional(
    v.array(
      v.object({ sha256: v.string(), size: v.number(), r2Key: v.string(), pack: v.optional(objectPack) }),
    ),
  ),
  recipeClosure: v.optional(recipeClosure),
  recipe: v.optional(v.object({ sha256: v.string(), size: v.number() })),
});
export const sourceStateSizes = v.optional(
  v.array(
    v.object({
      sha256: v.string(),
      size: v.number(),
      fileCount: v.number(),
      manifestBytes: v.number(),
    }),
  ),
);
export const sourceTaskData = v.object({ id: v.string(), sha256: v.string() });
export const sourceFailure = v.object({
  stage: v.union(...sourceFailureStages.map(value => v.literal(value))),
  exception: v.union(...sourceFailureClasses.map(value => v.literal(value))),
  code: v.union(...sourceFailureCodes.map(value => v.literal(value)), v.null()),
  step: v.optional(v.number()),
  call: v.optional(v.union(...sourceFailureCalls.map(value => v.literal(value)))),
  object: v.optional(v.string()),
  size: v.optional(v.number()),
  objects: v.optional(v.number()),
  elapsedMs: v.number(),
  httpStatus: v.union(v.number(), v.null()),
});
const retryFields = {
  failedAttempts: v.optional(v.number()),
  failedGeneration: v.optional(v.number()),
  retryAt: v.optional(v.number()),
  lastFailure: v.optional(sourceFailure),
  lastFailureAt: v.optional(v.number()),
};
export const sourceStepTables = {
  projectSourceSteps: defineTable({
    ...retryFields,
    generation: v.optional(v.number()),
    /** Captured once at dispatch, so retries never follow a later setting change. */
    physicalManifests: v.optional(v.literal(true)),
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    dispatch: v.string(),
    executionId: v.string(),
    scheduledId: v.optional(v.id('_scheduled_functions')),
    /** `scheduledId` is a delayed fallback for a first step the submitting action runs itself;
     * the step's commit cancels it while it is still pending. */
    inlineFallback: v.optional(v.boolean()),
    /** The delayed fallback found the inline run possibly still going and re-armed once (R1). */
    inlineRearmed: v.optional(v.boolean()),
    step: v.number(),
    cursor: v.union(v.string(), v.null()),
    batchId: v.optional(v.id('projectSourceBatches')),
    /** Server phase split for the operation's receipt (friction 84c1497f); older rows have none. */
    timing: v.optional(sourceExecutionTiming),
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
    // Only lease-fenced recovery needs a sparse queue; completed siblings stay retained.
    retryIndices: v.optional(v.array(v.number())),
    status: v.union(v.literal('queued'), v.literal('waiting'), v.literal('done'), v.literal('fenced')),
    failureReason: v.optional(v.string()),
    failure: v.union(v.string(), v.null()),
  })
    .index('by_status', ['status'])
    .index('by_project_and_job_and_step', ['projectId', 'jobId', 'step']),
  projectSourceTasks: defineTable({
    ...retryFields,
    retryUntil: v.optional(v.number()),
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
  })
    .index('by_batch_and_index', ['batchId', 'index'])
    .index('by_project', ['projectId']),
  projectSourcePools: defineTable({
    key: v.literal('source'),
    // Slots carry the batch and scheduled run so a drain can skip reading full
    // task documents (input windows) for work that is still running. Bare ids are
    // the earlier form and are read once, then rewritten as slots.
    active: v.array(
      v.union(
        v.id('projectSourceTasks'),
        v.object({
          task: v.id('projectSourceTasks'),
          batch: v.id('projectSourceBatches'),
          scheduled: v.id('_scheduled_functions'),
        }),
      ),
    ),
    drainQueued: v.optional(v.boolean()),
  }).index('by_key', ['key']),
};
