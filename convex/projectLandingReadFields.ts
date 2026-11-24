// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';

/** At most this many landings marked read one by one above `through`; marking all folds them into `through`. */
export const LANDING_READ_SET = 500;

export const setupVisibility = v.union(v.literal('automatic'), v.literal('hidden'), v.literal('shown'));
export const skippableSetupStep = v.union(
  v.literal('import'),
  v.literal('github'),
  v.literal('agent'),
  v.literal('land'),
);
const setupPreferenceFields = {
  visibility: setupVisibility,
  // The preference writer keeps one entry per skippable step (at most four), never accepts a whole array.
  skipped: v.array(skippableSetupStep),
  revision: v.number(),
};
export const setupPreferences = v.object(setupPreferenceFields);

export async function landingReadState(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  account: string,
) {
  return ctx.db
    .query('projectLandingReads')
    .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', account))
    .unique();
}

export const landingReadTables = {
  // To read (Item 9e748e41): one row per account and project. Every landing at or below `through` (an acceptance
  // sequence) is read; `read` holds the sequences above it read one by one. Written only when the reader marks.
  // `fyi` (Item 48049998): the same reader's Needs me › FYI state, written only on Dismiss or Clear all.
  projectLandingReads: defineTable({
    projectId: v.id('hostedProjects'),
    account: v.string(),
    through: v.number(),
    read: v.array(v.number()),
    at: v.number(),
    setup: v.optional(v.object({ ...setupPreferenceFields, operationId: v.string() })),
    fyi: v.optional(
      v.object({
        /** Clear all: rows at or before this time, and landings at or below this sequence, are cleared. */
        clearedAt: v.optional(v.number()),
        clearedSequence: v.optional(v.number()),
        /** Dismissed rows as `kind:id@version`, at most FYI_DISMISSED (convex/projectNeedsFyi.ts), oldest first. */
        dismissed: v.array(v.string()),
      }),
    ),
  }).index('by_project_and_account', ['projectId', 'account']),
};
