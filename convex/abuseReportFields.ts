// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

const abuseReportKind = v.union(
  v.literal('project'),
  v.literal('message'),
  v.literal('comment'),
  v.literal('account'),
);
export const abuseReportStatus = v.union(
  v.literal('open'),
  v.literal('dismissed'),
  v.literal('suspended'),
  v.literal('purged'),
);

/** The operator review queue (Item b6588425 line 2; convex/abuseReports.ts). One row per report, written inside the
 * report mutation; read only when an operator opens the queue. Never returned by a public function. */
export const abuseReportTables = {
  abuseReports: defineTable({
    /** The reporter's operation id: a retry with the same id returns this report. */
    operationId: v.string(),
    /** Auth subject of the reporter. */
    reporter: v.string(),
    kind: abuseReportKind,
    projectId: v.optional(v.id('hostedProjects')),
    /** Board note id or coordination message operation id (message), comment id (comment) or handle (account): with
     * kind, projectId, itemId and reason, what a replay of the operation must match. */
    targetId: v.optional(v.string()),
    /** The exact reported message document: review purges this row and no other. */
    noteId: v.optional(v.id('projectBoardMessages')),
    eventId: v.optional(v.id('projectCoordinationEvents')),
    /** The Item a reported comment is on. */
    itemId: v.optional(v.string()),
    /** Auth subject of the account the report is about: the author, the project owner or the account itself. */
    subject: v.string(),
    reason: v.string(),
    /** What the reporter saw, at most EXCERPT_CHARACTERS, kept so the operator can look after the content expires. */
    excerpt: v.string(),
    status: abuseReportStatus,
    at: v.number(),
    reviewedAt: v.optional(v.number()),
    /** The operator alert this report raised, if it raised one: the next alert waits REPORT_ALERT_MS after it. */
    alertedAt: v.optional(v.number()),
    /** The last review's operation id and what its purge removed (a report reviewed before `reviews` kept them). */
    reviewOperationId: v.optional(v.string()),
    removed: v.optional(v.number()),
    /** Each review's operation id, action and what its purge removed, the last REVIEW_RECEIPTS of them: a retry of any
     * returns its first result, even after a later review of the same report. */
    reviews: v.optional(
      v.array(
        v.object({
          operationId: v.string(),
          action: v.union(v.literal('suspend'), v.literal('purge'), v.literal('dismiss')),
          removed: v.optional(v.number()),
        }),
      ),
    ),
  })
    .index('by_reporter_and_operation', ['reporter', 'operationId'])
    .index('by_status_and_at', ['status', 'at'])
    // The newest alert: the last row of the alerted range.
    .index('by_alerted_at', ['alertedAt'])
    // A project purge removes the reports about it, excerpts included.
    .index('by_project', ['projectId']),
};
