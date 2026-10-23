// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
export const resourceKind = v.union(
  ...(['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'] as const).map(v.literal),
);
export const leaveKind = v.union(
  ...(['readers', 'zones', 'teams', 'projects', 'secrets'] as const).map(v.literal),
);
export const accountStage = v.union(
  ...(['preparing', 'ready', 'running', 'completed'] as const).map(v.literal),
);
export const accountSelection = v.object({ kind: resourceKind, id: v.string(), pin: v.string() });
export const accountItemState = v.union(
  ...(['pending', 'started', 'completed', 'changed'] as const).map(v.literal),
);
export const accountFields = {
  owner: v.string(),
  operationId: v.string(),
  request: v.string(),
  expectedItems: v.number(),
  leave: v.array(leaveKind),
  stage: accountStage,
  captured: v.array(leaveKind),
  pending: v.number(),
  at: v.number(),
};
export const accountItemFields = {
  owner: v.string(),
  accountId: v.id('accountOperations'),
  key: v.string(),
  resourceId: v.string(),
  kind: v.string(),
  pin: v.string(),
  operationId: v.string(),
  hidden: v.boolean(),
  state: accountItemState,
  expected: v.optional(
    v.object({
      revision: v.optional(v.number()),
      version: v.optional(v.number()),
      policyRevision: v.optional(v.number()),
      archiveRevision: v.optional(v.number()),
      creationOperationId: v.optional(v.string()),
      creation: v.optional(v.number()),
    }),
  ),
};
export const accountReceipt = v.object({
  operationId: v.string(),
  request: v.string(),
  stage: accountStage,
  at: v.number(),
});
