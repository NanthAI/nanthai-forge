// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** One project as the request froze it (Item 7456856f): what the owner is shown and what approval re-checks. */
// Project ids are kept as plain strings: the request is an account-owned receipt that outlives each purge, so the
// project purge inventory must not treat it as project-owned (tests/project-purge-inventory).
export const deleteRequestProject = v.object({
  projectId: v.string(),
  slug: v.string(),
  revision: v.number(),
  /** The newest accepted landing when the list was made (its row id), or null: a later landing skips the project. */
  landing: v.union(v.string(), v.null()),
  lastLandingAt: v.union(v.number(), v.null()),
  /** Reserved stored bytes (the project's storage counters). */
  bytes: v.number(),
  trash: v.boolean(),
});
export const deleteRequestOutcome = v.union(
  /** Approval started its permanent purge. */
  v.literal('started'),
  v.literal('deleted'),
  /** The purge stopped (storage did not answer); retry runs it again. Nothing is half-deleted. */
  v.literal('failed'),
  /** It changed after the list was made (a new landing, a rename, a restore): skipped, never deleted. */
  v.literal('changed'),
  /** The approver does not own it any more, or it is gone: refused, nothing changed. */
  v.literal('refused'),
);

export const deleteRequestTables = {
  /** Bulk permanent-delete requests (Item 7456856f). Anyone signed in to the account (a person, a device, an agent)
   * prepares one; only the owner person approves it, once, in the browser. Account-owned: one row per request, at most
   * DELETE_REQUEST_LIMIT projects, written on prepare, decision, and once per project when its purge ends. */
  projectDeleteRequests: defineTable({
    owner: v.string(),
    /** Who prepared it: the account subject and whether it was a device or agent sign-in. */
    requester: v.object({ device: v.boolean() }),
    operationId: v.string(),
    /** The canonical selection as sent (replay check). */
    request: v.string(),
    /** The selection in words: a name pattern, "N project ids" or "the trash". */
    selector: v.string(),
    at: v.number(),
    expiresAt: v.number(),
    projects: v.array(deleteRequestProject),
    status: v.union(
      v.literal('requested'),
      v.literal('approved'),
      v.literal('declined'),
      v.literal('withdrawn'),
    ),
    decision: v.optional(
      v.object({
        operationId: v.string(),
        at: v.number(),
        kept: v.array(v.string()),
        reason: v.optional(v.string()),
      }),
    ),
    results: v.optional(v.array(v.object({ projectId: v.string(), outcome: deleteRequestOutcome }))),
    /** Approvals whose terminal outcomes are tracked from the project's purge receipt. */
    tracksPurgeReceipt: v.optional(v.literal(true)),
  })
    .index('by_owner_and_operation', ['owner', 'operationId'])
    // index-order: caller: convex/projectDeleteRequests.ts#open; order: newest open request first.
    .index('by_owner_and_status', ['owner', 'status']),
};
