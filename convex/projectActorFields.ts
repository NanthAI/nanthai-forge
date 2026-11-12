// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const actorTables = {
  projectActorNames: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    /** Retired: no provider name is stored. Legacy rows are removed by purgeDisplayNames; drop this field after. */
    displayName: v.optional(v.string()),
    wasMember: v.optional(v.boolean()),
  })
    .index('by_project_and_actor', ['projectId', 'actor'])
    // index-order: Purge .take pages retain creation-time order within projectId; adding actor changes selected rows.
    .index('by_project', ['projectId']),
};
