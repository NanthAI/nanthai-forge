// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, coordinationQuery, isDeviceIdentity } from './cliServer';
// Self-revocation remains retryable after revocation; this endpoint only removes authority.
import { mutation } from './_generated/server';
import { deviceScope } from './deviceFields';
import { invariant } from '../src/errors';
const item = v.object({
  id: v.id('cliCredentials'),
  credentialId: v.string(),
  name: v.string(),
  scope: deviceScope,
  expiresAt: v.number(),
  revoked: v.boolean(),
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'AUTH_REQUIRED', 'Sign in to list devices.');
    const rows = await ctx.db
      .query('cliCredentials')
      .withIndex('by_owner', q => q.eq('owner', user.subject))
      .order('desc')
      .paginate(args.paginationOpts);
    return {
      ...rows,
      page: rows.page.map(row => ({
        id: row._id,
        credentialId: row.credentialId,
        name: row.name,
        scope: row.scope,
        expiresAt: row.expiresAt,
        revoked: row.revoked,
      })),
    };
  },
});
export const revoke = mutation({
  args: { credentialId: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    invariant(user && row?.owner === user.subject, 'AUTH_REQUIRED', 'Select your own device credential.');
    invariant(
      !isDeviceIdentity(user) || user.forgeCredential === row.credentialId,
      'AUTH_SCOPE_DENIED',
      'A CLI device can revoke itself.',
    );
    await ctx.db.patch(row._id, { revoked: true });
    return null;
  },
});
export const status = coordinationQuery({
  args: {},
  returns: v.object({ subject: v.string(), credentialId: v.union(v.string(), v.null()) }),
  handler: async ctx => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'AUTH_REQUIRED', 'Sign in to Forge.');
    return {
      subject: user.subject,
      credentialId: typeof user.forgeCredential === 'string' ? user.forgeCredential : null,
    };
  },
});
