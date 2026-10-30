// SPDX-License-Identifier: Apache-2.0
// Historic RPC addresses only; publication data stays readable through its stored validators.
import { ConvexError, v } from 'convex/values';
import { CUTOVER_UPGRADE } from '../src/cutover-version';
import { mutation, query } from './cliServer';
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
export const capabilities = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const publishedDisplay = query({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups') },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const displayBaseline = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const begin = mutation({
  args: {
    ...identity,
    request: v.string(),
    digest: v.string(),
    size: v.number(),
    metadataDigest: v.string(),
    pages: v.number(),
  },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
export const append = mutation({
  args: { id: v.id('projectPublications'), position: v.number(), previous: v.string(), body: v.string() },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
