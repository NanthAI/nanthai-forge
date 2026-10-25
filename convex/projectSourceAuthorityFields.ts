// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const sourceAuthority = v.object({
  mode: v.union(v.literal('native-owner'), v.literal('server-shadow'), v.literal('server')),
  epoch: v.number(),
});

export const sourceAuthorityTables = {
  projectSourceAuthorityTransitions: defineTable({
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    expected: sourceAuthority,
    authority: sourceAuthority,
  }).index('by_project_and_operation', ['projectId', 'operationId']),
};
