// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const actorTables = {
  projectActorNames: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    displayName: v.string(),
    wasMember: v.optional(v.boolean()),
  })
    .index('by_project_and_actor', ['projectId', 'actor'])
    .index('by_project', ['projectId']),
};
