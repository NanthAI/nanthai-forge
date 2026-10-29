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
  wake: v.optional(v.object({ taskId: v.id('_scheduled_functions'), at: v.number() })),
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
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
};
