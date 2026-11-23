// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const statsTables = {
  // Stats (Items a61d3c91, 2cf30e0a): one row per project per closed UTC day with landings, a `StatsDay`
  // (src/stats-estimate.ts) of counts, sorted seconds and the own-history replay. Written once by the day close.
  projectStatsDays: defineTable({
    runnerContributions: v.optional(
      v.array(
        v.object({
          submissionId: v.string(),
          reruns: v.number(),
          /** The close's resubmission test, so a late correction applies the same first-try rule. */
          resubmitted: v.optional(v.boolean()),
        }),
      ),
    ),
    /** Stopped runs of this day with no minutes yet, and the tally that holds each (src/stats-runs.ts#classifyRuns):
     * a late cancelled-run report adds its minutes there once (convex/projectCancelledRunDay.ts). */
    lateRuns: v.optional(v.array(v.object({ runId: v.string(), bucket: v.string() }))),
    // The day budgets' open break, ratchet and notes after this day (src/landing-speed-alerts.ts
    // judgeClosedDay, JSON); absent while no day budget holds state.
    budgets: v.optional(v.string()),
    projectId: v.id('hostedProjects'),
    day: v.string(),
    value: v.string(),
  }).index('by_project_and_day', ['projectId', 'day']),
  // All time (Item a61d3c91): one row per project per closed month, a `StatsMonth` (src/stats-period.ts) of its days'
  // totals, written once the month has closed (convex/projectStats.ts#rollMonth), so All time reads about 12 rows a year.
  projectStatsMonths: defineTable({
    projectId: v.id('hostedProjects'),
    month: v.string(),
    value: v.string(),
  }).index('by_project_and_month', ['projectId', 'month']),
};
