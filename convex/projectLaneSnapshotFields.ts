// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

const pin = v.object({ sha256: v.string(), size: v.number() });

/** Unsaved-work snapshots (Issue 7ac4e32f, src/lane-snapshot-contract.ts). One row per Lane holds
 * its totals and expiry (`kind: 'lane'`, seq 0); every other row is one operation-log entry. No
 * file bytes and no paths: the delta pages and changed files live in R2 under the Lane's snapshot
 * prefix. Visible only to the Lane author and the project owner; never source, never mirrored,
 * backed up or exported; deleted by expiry, purge or project deletion. */
export const laneSnapshotTables = {
  projectLaneSnapshots: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    seq: v.number(),
    kind: v.union(v.literal('lane'), v.literal('snapshot'), v.literal('restore')),
    /** Auth subject of the caller. Mapped to a Forge handle on every read (convex/publicPeople.ts). */
    actor: v.string(),
    operationId: v.string(),
    at: v.number(),
    /** Entries: `pending` until its uploads are committed. Lane row: `purging` while it is deleted. */
    state: v.union(v.literal('pending'), v.literal('live'), v.literal('purging')),
    head: v.optional(v.string()),
    tree: v.optional(v.string()),
    pages: v.optional(v.union(pin, v.null())),
    /** Pack shape (feature lane-snapshot-packs): the one R2 object holding the pages and new files. */
    pack: v.optional(v.union(pin, v.null())),
    changeCount: v.optional(v.number()),
    uploadBytes: v.optional(v.number()),
    notSaved: v.optional(v.number()),
    parent: v.optional(v.number()),
    target: v.optional(v.number()),
    move: v.optional(v.union(v.literal('undo'), v.literal('redo'), v.literal('restore'))),
    /** Lane row: next seq, reserved bytes, latest snapshot time, expiry and its scheduled job. */
    nextSeq: v.optional(v.number()),
    laneBytes: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    job: v.optional(v.id('_scheduled_functions')),
  })
    .index('by_project_and_lane_and_seq', ['projectId', 'laneId', 'seq'])
    .index('by_project_and_operation', ['projectId', 'operationId']),
};
