// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const clientErrorKind = v.union(
  v.literal('error'),
  v.literal('unhandledrejection'),
  v.literal('render'),
  v.literal('mutation'),
  v.literal('action'),
);
export const clientErrorFields = {
  /** Auth subject of the reporting account; never supplied by the client. */
  user: v.string(),
  operationId: v.string(),
  /** Set only when the reporter had current access to the project. */
  projectId: v.optional(v.id('hostedProjects')),
  kind: clientErrorKind,
  message: v.string(),
  stack: v.optional(v.string()),
  route: v.string(),
  build: v.string(),
  functionName: v.optional(v.string()),
  code: v.optional(v.string()),
};
export const clientErrorTables = {
  clientErrors: defineTable(clientErrorFields)
    .index('by_user_and_operationId', ['user', 'operationId'])
    .index('by_projectId', ['projectId']),
};
