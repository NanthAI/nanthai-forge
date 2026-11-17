// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
/** Failure log (Item 2c420916): one small row per failed operation or failed landing, written only in the
 * mutation that settles it as failed (convex/projectFailureLog.ts). A healthy path writes nothing; rows
 * expire after 30 days with the operational expiry pages. */
export const failureLogTables = {
  projectFailures: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    /** JSON `FailureRecord`: kind, code, sanitized message (at most 240 characters), elapsed time. */
    value: v.string(),
  })
    // index-order: caller: convex/projectFailureReport.ts#report; order: the health report reads a creation-time window newest first.
    .index('by_project', ['projectId'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
};
