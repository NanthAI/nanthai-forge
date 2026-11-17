// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** At most this many landings marked read one by one above `through`; marking all folds them into `through`. */
export const LANDING_READ_SET = 500;

export const landingReadTables = {
  // To read (Item 9e748e41): one row per account and project. Every landing at or below `through` (an acceptance
  // sequence) is read; `read` holds the sequences above it read one by one. Written only when the reader marks.
  projectLandingReads: defineTable({
    projectId: v.id('hostedProjects'),
    account: v.string(),
    through: v.number(),
    read: v.array(v.number()),
    at: v.number(),
  }).index('by_project_and_account', ['projectId', 'account']),
};
