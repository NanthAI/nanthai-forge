// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { feedAttentionReasons, feedKinds } from '../src/feed-event';

export const feedKind = v.union(...feedKinds.map(kind => v.literal(kind)));
const storedKind = v.union(...feedKinds.filter(kind => kind !== 'queue.moved').map(kind => v.literal(kind)));
const identity = {
  projectId: v.id('hostedProjects'),
  laneId: v.string(),
  id: v.string(),
  at: v.number(),
};
const details = {
  operationId: v.optional(v.string()),
  submissionId: v.optional(v.string()),
  receiptId: v.optional(v.string()),
  runId: v.optional(v.string()),
  noteId: v.optional(v.string()),
  code: v.optional(v.string()),
  reason: v.optional(v.union(...feedAttentionReasons.map(reason => v.literal(reason)))),
  sourceVersion: v.optional(v.number()),
};
export const feedEventViewValidator = v.object({
  ...identity,
  ...details,
  v: v.literal(1),
  kind: feedKind,
  position: v.optional(v.number()),
  resume: v.union(
    v.object({
      action: v.literal('wait'),
      input: v.object({ operationIds: v.array(v.string()), until: v.literal('acceptance') }),
    }),
    v.object({ action: v.literal('wait'), input: v.object({ runId: v.string() }) }),
    v.object({ action: v.literal('board'), input: v.object({ laneId: v.string() }) }),
    v.object({ action: v.literal('status'), input: v.object({ laneId: v.string() }) }),
  ),
});

export const feedTables = {
  projectFeedEvents: defineTable({
    ...identity,
    ...details,
    kind: storedKind,
    // Internal subject of the recipient Lane's holder when the event happened.
    actor: v.string(),
    recordVersion: v.optional(v.number()),
  })
    .index('by_project_and_at_and_id', ['projectId', 'at', 'id'])
    .index('by_project_and_lane_and_at_and_id', ['projectId', 'laneId', 'at', 'id']),
};
