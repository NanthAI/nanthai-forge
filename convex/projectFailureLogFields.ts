// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** Failure log (Item 2c420916): one small row per failed operation or failed landing, written only in the
 * mutation that settles it as failed (convex/projectFailureLog.ts). A healthy path writes nothing; rows
 * expire after 30 days with the operational expiry pages. */
export const failureLogTables = {
  projectHostedRecomposeAlerts: defineTable({
    projectId: v.id('hostedProjects'),
    groupId: v.string(),
    submissionId: v.string(),
    laneId: v.optional(v.string()),
    summary: v.string(),
  })
    .index('by_project_and_group', ['projectId', 'groupId'])
    // index-order: caller: convex/projectHostedLandingRecomposeAlerts.ts#recentRecomposeAlerts; order: the bounded owner notice page reads newest _creationTime first.
    .index('by_project', ['projectId']),
  projectFailures: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    /** JSON `FailureRecord`: kind, code, sanitized message (at most 240 characters), elapsed time; a failed check adds its failing files, step and first error (src/failure-noise.ts). */
    value: v.string(),
  })
    // index-order: caller: convex/projectFailureReport.ts#report; order: the health report reads a creation-time window newest first.
    .index('by_project', ['projectId'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
};
