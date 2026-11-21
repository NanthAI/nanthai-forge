// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const actorTables = {
  projectActorNames: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    wasMember: v.optional(v.boolean()),
    invitationsEndedBeforeEpoch: v.optional(v.number()),
  }).index('by_project_and_actor', ['projectId', 'actor']),
};
