// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { reserveSourceProvider, lookupSourceProvider, recordSourceProvider } from './projectSourceProvider';

// Trusted ingress authenticates the fixed bridge and resolves the job/project;
// these functions are never public source writers or client-selected providers.
const identity = { projectId: v.id('hostedProjects'), jobId: v.string(), input: v.string() };
export const reserve = internalMutation({
  args: { ...identity, token: v.string() },
  returns: v.string(),
  handler: async (ctx, input) =>
    JSON.stringify(await reserveSourceProvider(ctx, { ...input, input: JSON.parse(input.input) })),
});
export const lookup = internalQuery({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) =>
    JSON.stringify(await lookupSourceProvider(ctx, { ...input, input: JSON.parse(input.input) })),
});
export const created = internalMutation({
  args: { ...identity, token: v.string(), executionId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => recordSourceProvider(ctx, { ...input, input: JSON.parse(input.input) }),
});
