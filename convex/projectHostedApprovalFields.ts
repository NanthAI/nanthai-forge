// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Issue fe5bea80: a builder's request for the owner's go on one Lane. One row per Lane; a new
 * request on the same Lane reopens it. `live` rows apply to that Lane's landings: requested or
 * declined holds them; granted lets the exact approved Lane head land. Landing with it (or the
 * requester withdrawing it) ends it. */
export const hostedApprovalTables = {
  projectHostedApprovals: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    /** The latest request's operation id: its replay returns this row. */
    operationId: v.string(),
    requester: v.string(),
    /** The requesting agent session's word-list slug; absent for a person. */
    agent: v.optional(v.string()),
    /** A fork pull request's run request (Issue f7793473): the PR number. Such a row is never
     * `live` (a PR Lane never lands, so it holds no landing and costs other landings nothing);
     * it is open until `ended`, and the owner's grant starts the PR head's check-only run. */
    pullRequest: v.optional(v.number()),
    reason: v.string(),
    /** The Lane's saved head when the request was made. */
    head: v.string(),
    at: v.number(),
    status: v.union(v.literal('requested'), v.literal('granted'), v.literal('declined')),
    live: v.boolean(),
    decision: v.optional(
      v.object({
        operationId: v.string(),
        by: v.string(),
        at: v.number(),
        /** The Lane head the owner decided on (a grant covers exactly this head). */
        head: v.string(),
        reason: v.optional(v.string()),
        /** Decided on the Lane request itself, or by approving/declining its held landing. */
        via: v.union(v.literal('lane'), v.literal('landing')),
      }),
    ),
    /** Set when a landing carried the grant to main, the requester withdrew it, or (a fork PR
     * request) its run started or the PR head settled without one. */
    ended: v.optional(
      v.object({
        kind: v.union(v.literal('landed'), v.literal('withdrawn'), v.literal('settled')),
        at: v.number(),
      }),
    ),
    version: v.number(),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_live', ['projectId', 'live']),
};
