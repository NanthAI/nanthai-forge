// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { landingNoteBy } from './projectIntentLandingNoteFields';
const identity = { projectId: v.id('hostedProjects'), receiptId: v.string() };
const pin = v.object({ sha256: v.string(), size: v.number() });

/** Completion windows retain a set of Item roots, in first-observed order. */
export function acceptanceWorkItems(previous: readonly string[] | undefined, current: readonly string[]) {
  return [...new Set([...(previous ?? []), ...current])];
}

export const hostedAcceptanceTables = {
  projectHostedAcceptances: defineTable({
    ...identity,
    submissionId: v.string(),
    attemptId: v.string(),
    sequence: v.number(),
    value: v.string(),
    // Optional report facts outside the canonical receipt so installed readers keep its exact wire shape.
    retryCount: v.optional(v.number()),
    checkReused: v.optional(v.boolean()),
  })
    // index-order: caller: convex/projectHostedLandings.ts#read; order: landing history bounds _creationTime and paginates chronologically.
    .index('by_project', ['projectId'])
    .index('by_project_and_receipt', ['projectId', 'receiptId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_sequence', ['projectId', 'sequence']),
  // These are immutable snapshot deltas, selected by the Channel CAS. H21 can
  // fold them into portable recovery snapshots without cloning all Work here.
  projectHostedAcceptanceSnapshots: defineTable({
    projectId: v.id('hostedProjects'),
    snapshotId: v.string(),
    previousId: v.string(),
    receiptId: v.string(),
    sourceRevision: v.number(),
    head: v.string(),
  }).index('by_project_and_snapshot', ['projectId', 'snapshotId']),
  projectHostedAcceptanceEvents: defineTable({
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    sequence: v.number(),
    value: v.string(),
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
  projectHostedAcceptancePlans: defineTable({
    capsuleWake: v.optional(v.object({ submissionId: v.string(), dueAt: v.number() })),
    ...identity,
    submissionId: v.string(),
    attemptId: v.string(),
    actor: v.string(),
    inputsNext: v.union(pin, v.null()),
    dependenciesNext: v.union(pin, v.null()),
    inputPages: v.number(),
    dependencyPages: v.number(),
    lanes: v.number(),
    /** Single-page input IDs already validated by staging; wide and older plans use retained pages. */
    feedLanes: v.optional(v.array(v.object({ laneId: v.string(), actor: v.optional(v.string()) }))),
    /** A wide or already-staged selection emits on the existing completion windows. */
    feedCompletion: v.optional(v.object({ operationId: v.string(), runId: v.optional(v.string()) })),
    root: v.string(),
    appliedPage: v.number(),
    appliedEntry: v.number(),
    /** Item roots collected by earlier acceptance completion windows for one rollup fold. */
    workItemIds: v.optional(v.array(v.string())),
    /** Who published it and whether a person accepted it (Issue 3a733ee8), set with the completion tick
     * from facts publication holds; the tick copies it into each Item's system landing note. */
    landedBy: v.optional(landingNoteBy),
    /** The retained completion tick and its stall guard (Issue 13c63abe); absent once complete.
     * `replayed` is the position the guard last replayed from; `stalled` the typed end. */
    completion: v.optional(
      v.object({
        tick: v.id('_scheduled_functions'),
        alarm: v.optional(v.id('_scheduled_functions')),
        guard: v.union(v.id('_scheduled_functions'), v.null()),
        replayed: v.optional(v.object({ page: v.number(), entry: v.number() })),
        stalled: v.optional(
          v.object({
            code: v.literal('ACCEPTANCE_COMPLETION_STALLED'),
            message: v.string(),
            at: v.string(),
          }),
        ),
      }),
    ),
  }).index('by_project_and_receipt', ['projectId', 'receiptId']),
  projectHostedAcceptancePages: defineTable({
    ...identity,
    kind: v.union(v.literal('inputs'), v.literal('dependencies')),
    index: v.number(),
    laneActors: v.optional(v.record(v.string(), v.string())),
    digest: v.string(),
    root: v.string(),
    value: v.string(),
  }).index('by_project_and_receipt_and_kind_and_index', ['projectId', 'receiptId', 'kind', 'index']),
};
