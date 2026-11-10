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
};
