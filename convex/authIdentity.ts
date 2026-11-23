// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
// The resolver alone uses the raw identity; wrapping it would resolve itself recursively.
import { internalQuery } from './_generated/server';
import { accountFromSession, isAuthSession } from './forgeIdentity';

export const sessionAccount = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      accountKey: v.string(),
      userId: v.string(),
      sessionId: v.string(),
      deviceVerifiedUntil: v.optional(v.number()),
      email: v.optional(v.string()),
      emailVerified: v.optional(v.boolean()),
    }),
    v.null(),
  ),
  handler: async ctx => {
    const identity = await ctx.auth.getUserIdentity();
    return identity && isAuthSession(identity) ? accountFromSession(ctx, identity) : null;
  },
});
