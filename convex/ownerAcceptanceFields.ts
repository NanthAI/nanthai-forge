// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const ownerMachine = v.object({
  ownerId: v.string(),
  name: v.string(),
  lastSeen: v.number(),
  mainHead: v.union(v.string(), v.null()),
  command: v.string(),
});
export const acceptanceRequestFields = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  ownerId: v.string(),
  lifecycle: v.optional(v.string()),
  recheck: v.optional(v.literal(true)),
  agent: v.optional(v.literal(true)),
  viewId: v.string(),
  head: v.string(),
  expectedMain: v.union(v.string(), v.null()),
  actorKind: v.union(v.literal('person'), v.literal('agent')),
  channel: v.string(),
  requester: v.string(),
  createdAt: v.number(),
  state: v.union(v.literal('requested'), v.literal('accepted'), v.literal('rejected')),
  receipt: v.union(v.string(), v.null()),
};
export const acceptanceRequestDocument = v.object({
  _id: v.id('ownerAcceptanceRequests'),
  _creationTime: v.number(),
  ...acceptanceRequestFields,
});
export const ownerAcceptanceTables = {
  ownerAcceptanceMachines: defineTable({ projectId: v.id('hostedProjects'), ...ownerMachine.fields }).index(
    'by_project_owner',
    ['projectId', 'ownerId'],
  ),
  ownerAcceptanceRequests: defineTable(acceptanceRequestFields)
    .index('by_project_operation', ['projectId', 'operationId'])
    .index('by_project_view', ['projectId', 'viewId', 'channel'])
    .index('by_project_state', ['projectId', 'state']),
};
