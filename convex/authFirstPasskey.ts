// SPDX-License-Identifier: Apache-2.0
import { creationOptions, registrationResponse, registrationResult } from './authPasskeyWire';
import { startRegistration, finishRegistration } from './authPasskeyRegistration';
import { mutation } from './cliServer';
import { authComponents as components } from './authComponents';
import { invariant } from '../src/errors';
import type { MutationCtx } from './_generated/server';
import { isAuthSession } from './forgeIdentity';

const FRESH_SESSION_MS = 10 * 60 * 1000;
/** Each ceremony leg requires a live, recently minted browser session for its account. */
async function firstPasskeyAccount(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  invariant(
    identity &&
      isAuthSession(identity) &&
      typeof identity.forgeAuthUser === 'string' &&
      typeof identity.forgeAuthSession === 'string',
    'AUTH_REQUIRED',
    'Sign in to Forge in your browser.',
  );
  const id = ctx.db.normalizeId('users', identity.forgeAuthUser);
  const user = id && (await ctx.db.get(id));
  invariant(
    user && user.accountKey === identity.subject,
    'AUTH_REQUIRED',
    'Sign in to Forge in your browser.',
  );
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
  const current = sessions.find(session => session.sessionId === identity.forgeAuthSession);
  invariant(
    current && Date.now() - current.creationTime <= FRESH_SESSION_MS,
    'AUTH_EXPIRED',
    'Sign in again to add your first passkey.',
  );
  const passkeys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
  invariant(passkeys.length === 0, 'BAD_ARGUMENT', 'Use the existing add-passkey flow for another passkey.');
  return user;
}
export const start = mutation({
  args: {},
  returns: creationOptions,
  handler: async ctx => {
    const user = await firstPasskeyAccount(ctx);
    return startRegistration(ctx, user);
  },
});
export const finish = mutation({
  args: { response: registrationResponse },
  returns: registrationResult,
  handler: async (ctx, { response }) => {
    const user = await firstPasskeyAccount(ctx);
    return finishRegistration(ctx, user, response);
  },
});
