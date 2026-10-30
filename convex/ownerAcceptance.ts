// SPDX-License-Identifier: Apache-2.0
import { query, mutation, internalMutation } from './cliServer';
import { acceptanceRequestDocument, ownerMachine } from './ownerAcceptanceFields';
import { ConvexError, v } from 'convex/values';
import { CUTOVER_UPGRADE } from '../src/cutover-version';
const scope = { projectId: v.id('hostedProjects') };

// Keep RPC addresses for installed clients; the owner relay no longer runs.
export const request = mutation({
  args: {
    ...scope,
    operationId: v.string(),
    agent: v.optional(v.literal(true)),
    recheck: v.optional(v.literal(true)),
    authorityEpoch: v.optional(v.number()),
    channel: v.optional(v.string()),
    viewId: v.string(),
    head: v.string(),
    expectedMain: v.union(v.string(), v.null()),
  },
  returns: acceptanceRequestDocument,
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const status = query({
  args: { ...scope, viewId: v.string(), channel: v.optional(v.string()) },
  returns: v.object({
    native: v.boolean(),
    machine: v.union(ownerMachine, v.null()),
    request: v.union(acceptanceRequestDocument, v.null()),
    mainHead: v.union(v.string(), v.null()),
    mainAudit: v.optional(v.any()),
  }),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const pending = query({
  args: { ...scope, ownerId: v.string(), authorityEpoch: v.optional(v.number()) },
  returns: v.object({ operationId: v.union(v.string(), v.null()), indexReady: v.boolean() }),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const poll = mutation({
  args: { ...scope, ...ownerMachine.fields, authorityEpoch: v.optional(v.number()) },
  returns: v.union(acceptanceRequestDocument, v.null()),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const complete = mutation({
  args: { ...scope, ownerId: v.string(), operationId: v.string(), receipt: v.string() },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const route = internalMutation({
  args: {
    ...scope,
    operationId: v.string(),
    channel: v.string(),
    viewId: v.string(),
    head: v.string(),
    authorityEpoch: v.optional(v.number()),
  },
  returns: v.union(v.object({ expectedMain: v.union(v.string(), v.null()) }), v.null()),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
