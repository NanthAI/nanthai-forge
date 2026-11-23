// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const initiativeWorkIdentity = {
  projectId: v.id('hostedProjects'),
  initiativeId: v.string(),
};

export const initiativeWorkTables = {
  projectInitiativeWorkMembers: defineTable({
    ...initiativeWorkIdentity,
    kind: v.union(v.literal('summary'), v.literal('receipt'), v.literal('path')),
    key: v.string(),
    summary: v.optional(
      v.object({
        partition: v.id('projectWorkGenerations'),
        landings: v.number(),
        files: v.number(),
        missing: v.number(),
        stale: v.boolean(),
      }),
    ),
    rebuild: v.optional(
      v.object({
        id: v.string(),
        step: v.number(),
        phase: v.union(v.literal('clear'), v.literal('scan')),
      }),
    ),
    nextPath: v.optional(v.number()),
  }).index('by_project_and_initiative_and_kind_and_key', ['projectId', 'initiativeId', 'kind', 'key']),
};
