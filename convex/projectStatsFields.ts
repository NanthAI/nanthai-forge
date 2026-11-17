// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const statsTables = {
  // Stats (Items a61d3c91, 2cf30e0a): one row per project per closed UTC day with landings, a `StatsDay`
  // (src/stats-estimate.ts) of counts, sorted seconds and the own-history replay. Written once by the day close.
  projectStatsDays: defineTable({
    runnerContributions: v.optional(v.array(v.object({ submissionId: v.string(), reruns: v.number() }))),
    projectId: v.id('hostedProjects'),
    day: v.string(),
    value: v.string(),
  }).index('by_project_and_day', ['projectId', 'day']),
};
