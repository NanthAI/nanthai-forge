// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const clientErrorKind = v.union(
  v.literal('error'),
  v.literal('unhandledrejection'),
  v.literal('render'),
  v.literal('mutation'),
  v.literal('action'),
);
const operationFields = {
  /** Auth subject of the reporting account; never supplied by the client. */
  user: v.string(),
  operationId: v.string(),
  /** Ownership is optional across both variants. The writer sets it only on accepted member reports. */
  projectId: v.optional(v.id('hostedProjects')),
};
export const clientErrorFields = {
  ...operationFields,
  /** Positions count accepted reports within the same UTC day and scope. */
  reportDay: v.optional(v.number()),
  accountPosition: v.optional(v.number()),
  projectPosition: v.optional(v.number()),
  kind: clientErrorKind,
  message: v.string(),
  stack: v.optional(v.string()),
  route: v.string(),
  build: v.string(),
  functionName: v.optional(v.string()),
  code: v.optional(v.string()),
};
export const clientErrorTables = {
  clientErrors: defineTable(
    v.union(
      v.object(clientErrorFields),
      v.object({
        ...operationFields,
        dropDay: v.number(),
        dropPosition: v.number(),
      }),
    ),
  )
    .index('by_user_and_operationId', ['user', 'operationId'])
    // index-order: caller: convex/clientErrors.ts#recent; order: project diagnostics paginate newest first by creation time.
    .index('by_projectId', ['projectId'])
    .index('by_user_reportDay_accountPosition', ['user', 'reportDay', 'accountPosition'])
    .index('by_projectId_reportDay_projectPosition', ['projectId', 'reportDay', 'projectPosition'])
    .index('by_user_dropDay_dropPosition', ['user', 'dropDay', 'dropPosition']),
};
