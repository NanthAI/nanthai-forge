// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { deviceDocument, deviceFields, credentialDocument, credentialFields } from './deviceFields';
import { invariant } from '../src/errors';
export const start = internalMutation({
  args: deviceFields,
  returns: deviceDocument,
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query('deviceCodes')
      .withIndex('by_operationId', q => q.eq('operationId', args.operationId))
      .unique();
    if (old) {
      invariant(
        old.request === args.request && old.deviceHash === args.deviceHash && old.userHash === args.userHash,
        'AUTH_OPERATION_CHANGED',
        'Retain the original login request.',
      );
      return old;
    }
    const collision = await ctx.db
      .query('deviceCodes')
      .withIndex('by_userHash', q => q.eq('userHash', args.userHash))
      .unique();
    invariant(!collision, 'AUTH_CODE_COLLISION', 'Retry login with a new operation.');
    const id = await ctx.db.insert('deviceCodes', args);
    return (await ctx.db.get(id))!;
  },
});
export const attempt = internalMutation({
  args: { owner: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { owner }) => {
    const old = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', owner))
      .unique();
    const now = Date.now(),
      fresh = !old || now - old.windowAt >= 60_000;
    if (!fresh && old.count >= 10) return false;
    const value = { owner, windowAt: fresh ? now : old.windowAt, count: fresh ? 1 : old.count + 1 };
    if (old) await ctx.db.patch(old._id, value);
    else await ctx.db.insert('deviceAttempts', value);
    return true;
  },
});
export const lookup = internalQuery({
  args: { userHash: v.string() },
  returns: v.union(deviceDocument, v.null()),
  handler: (ctx, { userHash }) =>
    ctx.db
      .query('deviceCodes')
      .withIndex('by_userHash', q => q.eq('userHash', userHash))
      .unique(),
});
export const decide = internalMutation({
  args: { userHash: v.string(), owner: v.string(), approve: v.boolean(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('deviceCodes')
      .withIndex('by_userHash', q => q.eq('userHash', args.userHash))
      .unique();
    invariant(
      row && row.expiresAt > Date.now(),
      'AUTH_EXPIRED',
      'This device code expired or is unavailable.',
    );
    if (row.decisionId === args.operationId) {
      invariant(
        row.owner === args.owner && (row.state !== 'denied') === args.approve,
        'AUTH_OPERATION_CHANGED',
        'Retain the approving account and original decision.',
      );
      return null;
    }
    invariant(row.state === 'pending', 'AUTH_CODE_USED', 'This device code already has a decision.');
    await ctx.db.patch(row._id, {
      state: args.approve ? 'approved' : 'denied',
      owner: args.owner,
      decisionId: args.operationId,
    });
    return null;
  },
});
export const poll = internalMutation({
  args: { deviceHash: v.string(), operationId: v.string() },
  returns: v.object({ status: v.string(), device: v.union(deviceDocument, v.null()) }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('deviceCodes')
      .withIndex('by_deviceHash', q => q.eq('deviceHash', args.deviceHash))
      .unique();
    const result = (status: string) => ({ status, device: null });
    if (!row || row.expiresAt <= Date.now()) return result('expired_token');
    if (row.state === 'denied') return result('access_denied');
    if (row.state === 'consumed' && row.redemptionId !== args.operationId) return result('invalid_grant');
    if (row.nextPollAt > Date.now()) return result('slow_down');
    await ctx.db.patch(row._id, { nextPollAt: Date.now() + 5000 });
    if (row.state === 'pending') return result('authorization_pending');
    const update = {
      state: 'consumed' as const,
      redemptionId: args.operationId,
      issuedAt: row.issuedAt ?? Math.floor(Date.now() / 1000) * 1000,
    };
    await ctx.db.patch(row._id, update);
    return { status: 'approved', device: { ...row, ...update } };
  },
});
export const issue = internalMutation({
  args: credentialFields,
  returns: credentialDocument,
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    if (old) {
      invariant(
        old.owner === args.owner && old.tokenHash === args.tokenHash,
        'AUTH_OPERATION_CHANGED',
        'Retain the original credential.',
      );
      invariant(!old.revoked, 'AUTH_REVOKED', 'This credential has been revoked.');
      return old;
    }
    const id = await ctx.db.insert('cliCredentials', args);
    return (await ctx.db.get(id))!;
  },
});
export const authorize = internalQuery({
  args: { credentialId: v.string(), owner: v.string(), scope: v.string() },
  returns: credentialDocument,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    invariant(
      row && !row.revoked && row.expiresAt > Date.now() && row.owner === args.owner,
      'AUTH_REVOKED',
      'Forge login expired or was revoked. Run nforge login.',
    );
    invariant(
      row.scope === 'cli' || args.scope === 'coordination',
      'AUTH_SCOPE_DENIED',
      'This credential grants coordination only.',
    );
    return row;
  },
});
