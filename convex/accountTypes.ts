// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
export const resourceKind = v.union(
  ...(['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'] as const).map(v.literal),
);
export const leaveKind = v.union(
  ...(['readers', 'zones', 'teams', 'projects', 'projectReaders', 'secrets'] as const).map(v.literal),
);
/** What others shared with the person that the person can see, and so review row by row. Secret grants are not among
 * them: a hidden grant is never listed, counted or hashed into a review (accountExecute.leaveSecrets). */
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
  leave: v.array(leaveKind),
  stage: accountStage,
  captured: v.array(leaveKind),
  pending: v.number(),
  at: v.number(),
  /** The review epoch the cleanup was registered with: one that leaves secret grants leaves only those given below it
   * (secretGrantAuthority.givenBefore). */
  secretsBelow: v.optional(v.number()),
  /** The same by time, on receipts registered before epochs: grants given at or before it. */
  secretsBefore: v.optional(v.number()),
  /** Leaving those grants: unset until started, false while their rows are deleted in the background, true when done.
   * They stop giving access when it starts (forgeAccounts.secretsLeftBelow), so no receipt waits for or shows it. */
  secretsDone: v.optional(v.boolean()),
  /** Where the next background page starts, and the task that runs it: a failed task is rescheduled from here. */
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
      version: v.optional(v.number()),
      policyRevision: v.optional(v.number()),
      archiveRevision: v.optional(v.number()),
      creationOperationId: v.optional(v.string()),
      creation: v.optional(v.number()),
    }),
  ),
};
/** A closing account (convex/accountClose.ts): the close operation, when it started, the review epoch it issued
 * (secret grants given to the person below it stop giving access at once; closes from before epochs cut by `at`) and
 * the background step that runs next, with its task. */
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
