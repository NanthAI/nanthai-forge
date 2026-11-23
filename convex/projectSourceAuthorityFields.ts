// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const sourceAuthority = v.object({
  mode: v.union(v.literal('native-owner'), v.literal('server-shadow'), v.literal('server')),
  epoch: v.number(),
});

export const sourceAuthorityTables = {
  projectSourceCutovers: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    request: v.string(),
    receipt: v.string(),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
  projectSourceAuthorityTransitions: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    expected: sourceAuthority,
    authority: sourceAuthority,
    ownerDrain: v.optional(v.object({ revision: v.number(), fingerprint: v.string() })),
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
