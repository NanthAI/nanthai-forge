// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** One bounded row per (project, actor): at most 64 areas, 32 recent event ids and 32 delegations. */
export const hostedTrustTables = {
  projectHostedTrust: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    landings: v.number(),
    firstAt: v.string(),
    areas: v.array(
      v.object({
        area: v.string(),
        score: v.number(),
        at: v.string(),
        landings: v.number(),
        culprits: v.number(),
      }),
    ),
    applied: v.array(v.string()),
    delegations: v.array(
      v.object({
        decisionId: v.string(),
        patterns: v.array(v.string()),
        level: v.union(v.literal('trusted'), v.literal('autonomous')),
        until: v.optional(v.string()),
      }),
    ),
  }).index('by_project_and_actor', ['projectId', 'actor']),
};
