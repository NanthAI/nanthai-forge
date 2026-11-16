// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { authComponents as components } from './authComponents';
import { passkeyConfig } from './auth';
import { accountFor } from './urlIdentity';
import { handleError } from '../src/readable-urls';
import { invariant } from '../src/errors';
import type { MutationCtx } from './_generated/server';
import { isAuthSession } from './forgeIdentity';

const FRESH_SESSION_MS = 10 * 60 * 1000;
const credentialType = v.literal('public-key');
const descriptor = v.object({ id: v.string(), type: credentialType });
const options = v.object({
  rp: v.object({ id: v.string(), name: v.string() }),
  user: v.object({ id: v.string(), name: v.string(), displayName: v.string() }),
  challenge: v.string(),
  pubKeyCredParams: v.array(v.object({ alg: v.number(), type: credentialType })),
  timeout: v.number(),
  excludeCredentials: v.array(descriptor),
  authenticatorSelection: v.object({
    residentKey: v.literal('required'),
    requireResidentKey: v.literal(true),
    userVerification: v.literal('required'),
  }),
  attestation: v.literal('none'),
  extensions: v.object({}),
});
// Wire contract of the pinned component. PRF/envelope ceremonies are separate.
const response = v.object({
  id: v.string(),
  rawId: v.string(),
  type: credentialType,
  response: v.object({
    clientDataJSON: v.string(),
    attestationObject: v.string(),
    transports: v.optional(v.array(v.string())),
  }),
  clientExtensionResults: v.object({}),
});
const result = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.object({
      error: v.union(v.literal('CHALLENGE_EXPIRED'), v.literal('PROTOCOL_ERROR'), v.literal('INVALID_NAME')),
    }),
  }),
);
const b64url = (bytes: ArrayBuffer) => {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
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
  returns: options,
  handler: async ctx => {
    const user = await firstPasskeyAccount(ctx);
    const handle = (await accountFor(ctx, user.accountKey))?.handle;
    invariant(
      handle && !handleError(handle),
      'BAD_ARGUMENT',
      'Choose a Forge handle before adding a passkey.',
    );
    const set = await ctx.runMutation(components.authUsername.public.setUsername, {
      userId: user._id,
      username: handle,
    });
    invariant(set.success, 'BAD_ARGUMENT', 'Choose an available handle before adding a passkey.');
    const start = await ctx.runMutation(
      components.authPasskey.registration.startRegistrationForExistingUser,
      { verifiedUserId: user._id },
    );
    return {
      rp: { id: passkeyConfig.rpId, name: passkeyConfig.rpName },
      user: { id: b64url(start.userHandle), name: handle, displayName: handle },
      challenge: b64url(start.challenge),
      pubKeyCredParams: [-7, -257].map(alg => ({ alg, type: 'public-key' as const })),
      timeout: 9 * 60 * 1000,
      excludeCredentials: start.excludeCredentials.map(item => ({
        id: b64url(item.id),
        type: 'public-key' as const,
      })),
      authenticatorSelection: {
        residentKey: 'required' as const,
        requireResidentKey: true as const,
        userVerification: 'required' as const,
      },
      attestation: 'none' as const,
      extensions: {},
    };
  },
});
export const finish = mutation({
  args: { response },
  returns: result,
  handler: async (ctx, { response }) => {
    const user = await firstPasskeyAccount(ctx);
    return ctx.runMutation(
      components.authPasskey.registration._internal_dangerous_finishRegistrationForExistingUser,
      {
        expectedRpId: passkeyConfig.rpId,
        expectedOrigin: passkeyConfig.origin,
        verifiedUserId: user._id,
        response,
        name: 'First passkey',
      },
    );
  },
});
