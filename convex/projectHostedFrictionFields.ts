// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const record = { projectId: v.id('hostedProjects'), id: v.string(), request: v.string(), value: v.string() };
export const hostedFrictionTables = {
  projectHostedFriction: defineTable({
    ...record,
    actor: v.string(),
    likelyDuplicates: v.optional(v.string()),
    /** Latest triage state (JSON), patched when a triage event lands; absent means open. */
    triage: v.optional(v.string()),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project', ['projectId']),
  projectHostedFrictionHints: defineTable({
    projectId: v.id('hostedProjects'),
    id: v.string(),
    value: v.string(),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project', ['projectId']),
  projectHostedOverlapAcks: defineTable({
    ...record,
    actor: v.string(),
    laneId: v.string(),
    noticeId: v.string(),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    // `actor` last: an answer counts only from the Lane's author or the project owner (8809fba5).
    .index('by_project_and_lane_and_notice', ['projectId', 'laneId', 'noticeId', 'actor'])
    // Creation-time order serves the answer window read and the 90-day cleanup (Issue b78ca196).
    .index('by_project', ['projectId'])
    .index('by_project_and_lane', ['projectId', 'laneId']),
  projectHostedAckBatches: defineTable({ ...record, actor: v.string() })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project', ['projectId']),
};
