// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const hostedSaveTables = {
  projectHostedSaves: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    jobId: v.string(),
    laneId: v.optional(v.string()),
    commitTs: v.optional(v.commitTs()),
    background: v.optional(v.literal(true)),
    value: v.string(),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_job', ['projectId', 'jobId'])
    .index('by_project_and_lane_and_commit', ['projectId', 'laneId', 'commitTs']),
  projectHostedSavePages: defineTable({
    journalLaneId: v.optional(v.string()),
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    index: v.number(),
    digest: v.string(),
  })
    .index('by_project_and_journal_lane', ['projectId', 'journalLaneId'])
    .index('by_project_and_actor_and_operation_and_index', ['projectId', 'actor', 'operationId', 'index']),
  /** Owner purges of one save's stored bytes after a leak (Item 9d3c407d): the retry-safe receipt
   * (one row per operation id) and the R2 work left. The Lane's timeline keeps the visible tombstone,
   * each purged object row its PURGED mark. */
  projectSavePurges: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    laneId: v.string(),
    head: v.string(),
    parent: v.string(),
    actor: v.string(),
    at: v.number(),
    state: v.union(v.literal('marked'), v.literal('done')),
    files: v.array(v.object({ path: v.string(), blob: v.string(), size: v.number() })),
    /** R2 work: whole objects to delete, and upload-pack members to zero in place. */
    deletes: v.array(v.string()),
    zero: v.array(v.object({ key: v.string(), offset: v.number(), size: v.number() })),
    doneAt: v.optional(v.number()),
    /** When a retry last resumed the R2 step: the busy check counts from here. */
    leaseAt: v.optional(v.number()),
  })
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_state', ['projectId', 'state'])
    // index-order: caller: convex/gitServeLaneStore.ts#record; order: the Lane's newest purge fences a Git build that started before it.
    .index('by_project_and_lane', ['projectId', 'laneId']),
  projectHostedStates: defineTable({
    projectId: v.id('hostedProjects'),
    head: v.string(),
    size: v.number(),
    input: v.string(),
    jobId: v.string(),
    output: v.string(),
  })
    .index('by_project_and_head', ['projectId', 'head'])
    // index-order: caller: convex/projectStateGenerationRepair.ts#fromParents; order: repair bounds _creationTime and visits parents before children in publication order.
    .index('by_project', ['projectId']),
};
