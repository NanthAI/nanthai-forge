// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Agent coordination board (Issue 9c8490a4). Bodies live 14 days and at most 5,000 per project.
 * Cleanup runs inside posts, so an idle board makes no calls. Not source: excluded from the
 * GitHub mirror, backups and exports, and readable only by members with write access. */
export const boardTables = {
  projectBoardMessages: defineTable({
    projectId: v.id('hostedProjects'),
    /** The post operationId: a retry with the same id returns this message. */
    id: v.string(),
    /** Auth subject. Mapped to a Forge handle on every read (convex/publicPeople.ts). */
    author: v.string(),
    fromLaneId: v.optional(v.string()),
    /** `lane:<uuid>`, `issue:<uuid>` or `project`. */
    targetKey: v.string(),
    replyTo: v.optional(v.string()),
    body: v.string(),
    paths: v.optional(v.array(v.string())),
    bytes: v.number(),
    /** Digest of target and body: the same note to the same target within 24 h is a duplicate. */
    bodyHash: v.string(),
    at: v.number(),
    expiresAt: v.number(),
  })
    .index('by_project_and_id', ['projectId', 'id'])
    .index('by_project_and_target_and_at', ['projectId', 'targetKey', 'at'])
    .index('by_project_and_author_and_hash_and_at', ['projectId', 'author', 'bodyHash', 'at'])
    .index('by_project_and_reply', ['projectId', 'replyTo'])
    .index('by_project_and_expiry', ['projectId', 'expiresAt'])
    .index('by_author_and_at', ['author', 'at']),
  /** One row per target: delivery point-reads it and reads messages only when latestAt moved. */
  projectBoardInboxes: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    latestAt: v.number(),
    count: v.number(),
  }).index('by_project_and_key', ['projectId', 'key']),
  /** Rate windows: `lane:<uuid>` (or `member:<subject>` without a Lane) 10 per 10 min;
   * `day:<subject>` 300 per day per member per project. */
  projectBoardSenders: defineTable({
    projectId: v.id('hostedProjects'),
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index('by_project_and_key', ['projectId', 'key']),
  /** Live message count for the 5,000 cap, and the project's note clock. */
  projectBoardProjects: defineTable({
    projectId: v.id('hostedProjects'),
    live: v.number(),
    firstPostAt: v.number(),
    /** The last note's `at`: each note gets a later one, so a client cursor never skips a note. */
    lastAt: v.optional(v.number()),
  }).index('by_project', ['projectId']),
  /** Per-account daily totals across all projects, for the account caps and odd-pattern alerts. */
  boardAccounts: defineTable({
    author: v.string(),
    dayStart: v.number(),
    posts: v.number(),
    bytes: v.number(),
    /** Distinct projects posted to today, at most the alert threshold + 1. */
    projects: v.array(v.string()),
    /** Projects younger than a day that had their first board post today. */
    newProjects: v.number(),
    /** Alert kinds already sent today (one alert per kind per account per day). */
    alerted: v.array(v.string()),
  }).index('by_author', ['author']),
  /** Operator stop switches: `global`, `project:<id>`, `account:<subject>`. */
  boardSwitches: defineTable({
    key: v.string(),
    off: v.boolean(),
    at: v.number(),
  }).index('by_key', ['key']),
  /** Every operator switch or purge. Never returned by a public function. */
  boardAudit: defineTable({
    action: v.string(),
    target: v.string(),
    reason: v.string(),
    at: v.number(),
    detail: v.optional(v.string()),
  }).index('by_at', ['at']),
  /** Metadata without bodies, kept after the body expires for abuse investigation. */
  boardEvidence: defineTable({
    messageId: v.string(),
    projectId: v.id('hostedProjects'),
    author: v.string(),
    fromLaneId: v.optional(v.string()),
    targetKey: v.string(),
    at: v.number(),
    bytes: v.number(),
    /** Lanes the target reached when known (a Lane: 1); null for project-wide notes. */
    recipients: v.union(v.number(), v.null()),
    expiresAt: v.number(),
  })
    .index('by_expiry', ['expiresAt'])
    .index('by_author_and_at', ['author', 'at'])
    .index('by_project_and_at', ['projectId', 'at']),
};
