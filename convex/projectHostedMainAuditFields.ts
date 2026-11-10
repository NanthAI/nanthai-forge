// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const checkGate = v.object({
  mode: v.union(
    v.literal('contract'),
    v.literal('scoped'),
    v.literal('audit'),
    v.literal('probe'),
    v.literal('full'),
  ),
  tests: v.optional(v.array(v.string())),
  contractVersion: v.optional(v.number()),
  reason: v.optional(v.string()),
  effective: v.optional(v.union(v.literal('contract'), v.literal('full'), v.literal('docs'))),
});
export const drillRecord = v.object({
  startedAt: v.string(),
  redAt: v.optional(v.string()),
  recoveredAt: v.optional(v.string()),
  endedAt: v.optional(v.string()),
  outcome: v.optional(v.union(v.literal('recovered'), v.literal('late'), v.literal('flake'))),
});
export const mainAuditFields = {
  projectId: v.id('hostedProjects'),
  lastGreen: v.optional(v.object({ sequence: v.number(), head: v.string(), runId: v.string() })),
  unaudited: v.optional(v.object({ count: v.number(), firstAt: v.union(v.string(), v.null()) })),
  audit: v.optional(
    v.object({
      runId: v.string(),
      head: v.string(),
      sequence: v.number(),
      status: v.union(
        v.literal('queued'),
        v.literal('preparing'),
        v.literal('dispatching'),
        v.literal('running'),
        v.literal('unknown'),
        v.literal('passed'),
        v.literal('failed'),
        v.literal('cancelled'),
        v.literal('interrupted'),
        v.literal('runner-unavailable'),
      ),
    }),
  ),
  red: v.optional(
    v.object({ since: v.string(), head: v.string(), runId: v.string(), culprit: v.optional(v.string()) }),
  ),
  debt: v.optional(v.boolean()),
  /** Newest main revision that landed on its first check (7fe54c7c); audited promptly. */
  firstCheck: v.optional(v.number()),
  wake: v.optional(v.object({ taskId: v.id('_scheduled_functions'), at: v.number() })),
  /** What the project's audit history has earned toward fast landing mode (src/landing-mode.ts,
   * 81d12a32). Written only in transactions that already write this row. */
  earned: v.optional(
    v.object({
      audited: v.number(),
      unclear: v.number(),
      drill: v.optional(
        v.object({
          at: v.string(),
          sequence: v.number(),
          reverted: v.boolean(),
          started: v.optional(v.string()),
          red: v.optional(v.string()),
        }),
      ),
      lost: v.optional(v.object({ at: v.string(), reason: v.literal('red') })),
    }),
  ),
  /** An owner's red-audit drill in progress (fe7d67a8): started by the owner person, it claims the
   * first red audit in its window. Cleared when that red ends or a later red finds it expired. */
  drill: v.optional(
    v.object({
      startedAt: v.string(),
      red: v.optional(v.object({ at: v.string(), runId: v.string(), sequence: v.number() })),
    }),
  ),
  /** Consecutive audit starts that could not run (53b07031); cleared once one does. */
  startFailure: v.optional(
    v.object({ attempts: v.number(), code: v.string(), message: v.string(), at: v.string() }),
  ),
};
export const hostedMainAuditTables = {
  projectHostedMainAudits: defineTable(mainAuditFields).index('by_project', ['projectId']),
  projectHostedMainAuditEvents: defineTable({
    projectId: v.id('hostedProjects'),
    kind: v.union(
      v.literal('red'),
      v.literal('green'),
      v.literal('flake'),
      v.literal('stalled'),
      v.literal('culprit'),
    ),
    at: v.string(),
    head: v.string(),
    runId: v.string(),
    sequence: v.number(),
    culprit: v.optional(v.string()),
    /** On the red an owner's drill claimed, and on the verdict that ended it: its start, red,
     * recovery and end times, and whether it counted (recovered in time) or was a real red. */
    drill: v.optional(drillRecord),
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
};
