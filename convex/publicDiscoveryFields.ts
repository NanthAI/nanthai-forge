// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Public discovery (Items 8947a779, 76be0714): one small row per project that a visitor can find, and one row per
 * star. Neither is read or written by a landing; the public read joins them at read time. */
export const publicDiscoveryTables = {
  // One row per project with public settings or stars. `listed` is true while the project is public and not being
  // removed, so explore and profiles read listed rows only.
  projectPublic: defineTable({
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    listed: v.boolean(),
    /** Stars from signed-in people; updated in the same transaction as the star row. */
    stars: v.number(),
    /** Show open Lane titles to visitors ("show work in progress", D.3); off by default. The plan's public settings
     * are the planning contract's (an Item's `hidden`, the project's `planVisibility`), not stored here. */
    laneTitles: v.optional(v.boolean()),
    /** A fork's upstream project and the main head it was taken from (Item d1303286). A plain id string: the row
     * belongs to its own project only (purge inventory), and every read re-checks that the upstream still exists
     * and is public. */
    upstream: v.optional(v.object({ projectId: v.string(), head: v.string() })),
    /** Landings counted when the public page was last drawn (at most once per 10 minutes, only when someone
     * looks); explore ranks by it without reading every project's landings. Never written by a landing. */
    activity: v.optional(
      v.object({
        at: v.number(),
        landings: v.number(),
        days: v.array(v.number()),
        lastAt: v.optional(v.number()),
        recordedSince: v.optional(v.number()),
        main: v.union(v.literal('passing'), v.literal('unchecked')),
      }),
    ),
  })
    .index('by_projectId', ['projectId'])
    .index('by_listed_and_stars', ['listed', 'stars'])
    .index('by_owner_and_listed', ['owner', 'listed']),
  // A star is a person's, one per account and project; agents cannot star.
  projectStars: defineTable({ projectId: v.id('hostedProjects'), account: v.string() })
    .index('by_project_and_account', ['projectId', 'account'])
    .index('by_account', ['account']),
};
