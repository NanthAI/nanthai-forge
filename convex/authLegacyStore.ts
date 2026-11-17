// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import { authComponents as components } from './authComponents';
import { accountFor } from './urlIdentity';
import { invariant } from '../src/errors';
import { confirmAccount, confirmationOptions, digest } from './authLinkAccount';
import { startRegistration, finishRegistration } from './authPasskeyRegistration';
import {
  authenticationResponse,
  creationOptions,
  registrationResponse,
  registrationResult,
  requestOptions,
} from './authPasskeyWire';

const proof = { accountKey: v.string(), sessionId: v.string(), operationId: v.string() };
const PURPOSE = 'forge:legacy-passkey';
/** Only the legacy action supplies this proof, immediately after checking the provider.
 * Recheck the authenticated target in every transaction that starts or grants a ceremony. */
async function legacyAccount(ctx: MutationCtx, args: { accountKey: string; sessionId: string }) {
  const identity = await ctx.auth.getUserIdentity();
  invariant(
    identity &&
      process.env.CLERK_JWT_ISSUER_DOMAIN &&
      identity.issuer === process.env.CLERK_JWT_ISSUER_DOMAIN &&
      identity.subject === args.accountKey &&
      (identity.sid === undefined || identity.sid === args.sessionId),
    'AUTH_REQUIRED',
    'Sign in to your existing Forge account.',
  );
  const account = await accountFor(ctx, identity.subject);
  invariant(account, 'AUTH_REQUIRED', 'Sign in to your existing Forge account.');
  let user = await ctx.db
    .query('users')
    .withIndex('by_accountKey', q => q.eq('accountKey', account.owner))
    .unique();
  if (!user) {
    const id = await ctx.db.insert('users', {
      accountKey: account.owner,
      emailVerified: false,
      legacyGithubProvider: true,
    });
    user = (await ctx.db.get(id))!;
  }
  return user;
}
export const start = internalMutation({
  args: proof,
  returns: v.union(
    v.object({ step: v.literal('authenticate'), options: requestOptions }),
    v.object({ step: v.literal('register'), options: creationOptions }),
  ),
  handler: async (ctx, args) => {
    const user = await legacyAccount(ctx, args);
    const keys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
    await ctx.db.patch(user._id, {
      legacyPasskeyFlow: { operationId: args.operationId, sessionId: args.sessionId, confirmed: false },
    });
    return keys.length
      ? { step: 'authenticate' as const, options: await confirmationOptions(ctx, user, PURPOSE) }
      : { step: 'register' as const, options: await startRegistration(ctx, user) };
  },
});
export const confirm = internalMutation({
  args: { ...proof, response: authenticationResponse },
  returns: creationOptions,
  handler: async (ctx, args) => {
    const user = await legacyAccount(ctx, args);
    invariant(
      user.legacyPasskeyFlow?.operationId === args.operationId &&
        user.legacyPasskeyFlow.sessionId === args.sessionId,
      'AUTH_EXPIRED',
      'Start adding your passkey again.',
    );
    await confirmAccount(ctx, user, PURPOSE, args.response);
    await ctx.db.patch(user._id, {
      legacyPasskeyFlow: { operationId: args.operationId, sessionId: args.sessionId, confirmed: true },
    });
    return startRegistration(ctx, user);
  },
});
export const finish = internalMutation({
  args: { ...proof, response: registrationResponse },
  returns: registrationResult,
  handler: async (ctx, args) => {
    const user = await legacyAccount(ctx, args);
    const request = await digest(JSON.stringify(args.response));
    const receipt = await ctx.db
      .query('authLinkEvents')
      .withIndex('by_user_and_operation', q => q.eq('userId', user._id).eq('operationId', args.operationId))
      .unique();
    if (receipt) {
      invariant(
        receipt.kind === 'legacy-passkey' &&
          receipt.request === request &&
          receipt.sessionId === args.sessionId,
        'WORK_OPERATION_CHANGED',
        'Retry the original passkey registration.',
      );
      return { success: true as const, passkeyId: receipt.identityId };
    }
    const flow = user.legacyPasskeyFlow;
    invariant(
      flow?.operationId === args.operationId && flow.sessionId === args.sessionId,
      'AUTH_EXPIRED',
      'Start adding your passkey again.',
    );
    const keys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
    invariant(keys.length === 0 || flow.confirmed, 'AUTH_REQUIRED', 'Confirm with your existing passkey.');
    const result = await finishRegistration(ctx, user, args.response);
    if (result.success) {
      await ctx.db.patch(user._id, { legacyPasskeyFlow: undefined });
      await ctx.db.insert('authLinkEvents', {
        userId: user._id,
        operationId: args.operationId,
        request,
        kind: 'legacy-passkey',
        sessionId: args.sessionId,
        identityId: result.passkeyId,
        at: Date.now(),
      });
    }
    return result;
  },
});
