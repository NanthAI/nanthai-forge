// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
export const resourceKind = v.union(
  ...(['project', 'import', 'agent', 'team', 'view', 'interest'] as const).map(v.literal),
);
export const leaveKind = v.union(
  ...(['readers', 'zones', 'teams', 'projects', 'projectReaders'] as const).map(v.literal),
);
/** Stored `leave` and `captured` lists may still name `secrets` until the Secret Object purge has run
 * (convex/secretObjectsRetire.ts); the follow-up landing narrows them to `leaveKind`. */
const storedLeaveKind = v.union(leaveKind, v.literal('secrets'));
/** What others shared with the person that the person can see, and so review row by row. */
export const sharedKind = v.union(
  ...(['projects', 'projectReaders', 'readers', 'teams', 'zones'] as const).map(v.literal),
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
  leave: v.array(storedLeaveKind),
  stage: accountStage,
  captured: v.array(storedLeaveKind),
  pending: v.number(),
  at: v.number(),
  /** Retired Secret Object fields, never written now. They stay until the purge has run (convex/secretObjectsRetire.ts);
   * the follow-up landing deletes them. */
  secretsBelow: v.optional(v.number()),
  secretsBefore: v.optional(v.number()),
  secretsDone: v.optional(v.boolean()),
  secretsCursor: v.optional(v.union(v.string(), v.null())),
  secretsTask: v.optional(v.id('_scheduled_functions')),
  /** How many selected items Forge kept because they changed after the review (each one's step found a new pin). */
  kept: v.optional(v.number()),
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
      /** Retired Secret Object fields (see accountFields). */
      version: v.optional(v.number()),
      policyRevision: v.optional(v.number()),
      archiveRevision: v.optional(v.number()),
      creationOperationId: v.optional(v.string()),
      creation: v.optional(v.number()),
    }),
  ),
};
/** A closing account (convex/accountClose.ts): the close operation, when it started and the background step that runs
 * next, with its task. `below` and the `secrets` phase are retired (see accountFields). */
export const accountClosing = v.object({
  operationId: v.string(),
  at: v.number(),
  below: v.optional(v.number()),
  phase: v.union(v.literal('secrets'), v.literal('receipts'), v.literal('signout'), v.literal('finish')),
  cursor: v.union(v.string(), v.null()),
  task: v.optional(v.id('_scheduled_functions')),
});
export const accountReceipt = v.object({
  operationId: v.string(),
  request: v.string(),
  stage: accountStage,
  at: v.number(),
  kept: v.number(),
});
