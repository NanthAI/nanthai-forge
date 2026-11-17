// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import type { Infer } from 'convex/values';
import { authComponents as components } from './authComponents';
import { isAuthSession } from './forgeIdentity';
import { invariant } from '../src/errors';
import { passkeyConfig } from './auth';
import { authenticationResponse, b64url } from './authPasskeyWire';

export async function linkAccount(ctx: MutationCtx | QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  invariant(
    identity &&
      isAuthSession(identity) &&
      typeof identity.forgeAuthUser === 'string' &&
      typeof identity.forgeAuthSession === 'string',
    'AUTH_REQUIRED',
    'Sign in to this Forge account.',
  );
  const id = ctx.db.normalizeId('users', identity.forgeAuthUser);
  const user = id && (await ctx.db.get(id));
  invariant(user && user.accountKey === identity.subject, 'AUTH_REQUIRED', 'Sign in to this Forge account.');
  return { user, sessionId: identity.forgeAuthSession };
}
export async function confirmationOptions(ctx: MutationCtx, user: Doc<'users'>, purpose: string) {
  const started = await ctx.runMutation(components.authPasskey.authentication.startAuthentication, {
    purpose,
    userId: user._id,
  });
  return {
    challenge: b64url(started.challenge),
    timeout: 9 * 60 * 1000,
    rpId: passkeyConfig.rpId,
    allowCredentials: started.allowCredentials.map(value => ({
      id: b64url(value.id),
      type: 'public-key' as const,
      ...(value.transports ? { transports: value.transports } : {}),
    })),
    userVerification: 'required' as const,
  };
}
export async function confirmAccount(
  ctx: MutationCtx,
  user: Doc<'users'>,
  purpose: string,
  response: Infer<typeof authenticationResponse>,
) {
  const checked = await ctx.runMutation(components.authPasskey.authentication.finishAuthentication, {
    purpose,
    expectedRpId: passkeyConfig.rpId,
    expectedOrigin: passkeyConfig.origin,
    response,
  });
  invariant(
    checked.success && checked.userId === user._id,
    'AUTH_REQUIRED',
    'Confirm with a passkey for this Forge account.',
  );
}
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');
}
