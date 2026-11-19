// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** Regression ladder rung 1: one row per project, the last 7 days of landing timings
 * (src/landing-speed-alerts.ts). Written only inside the landing's own accept mutation. */
export const landingSpeedTables = {
  projectLandingSpeed: defineTable({
    projectId: v.id('hostedProjects'),
    value: v.string(),
    /** The learned preflight guard set's check failures (Item 13ea93bf):
     * written only by a landing whose check failed, at most 4 KB. */
    guards: v.optional(v.string()),
  }).index('by_project', ['projectId']),
};
