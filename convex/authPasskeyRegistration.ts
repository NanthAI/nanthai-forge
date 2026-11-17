// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import type { Infer } from 'convex/values';
import { registrationResponse, b64url } from './authPasskeyWire';
import { authComponents as components } from './authComponents';
import { passkeyConfig } from './auth';
import { accountFor } from './urlIdentity';
import { handleError } from '../src/readable-urls';
import { invariant } from '../src/errors';

/** Call only after proving the current account, and its passkey when one exists. */
export async function startRegistration(ctx: MutationCtx, user: Doc<'users'>) {
  const handle = (await accountFor(ctx, user.accountKey))?.handle;
  invariant(handle && !handleError(handle), 'BAD_ARGUMENT', 'Choose a Forge handle before adding a passkey.');
  const set = await ctx.runMutation(components.authUsername.public.setUsername, {
    userId: user._id,
    username: handle,
  });
  invariant(set.success, 'BAD_ARGUMENT', 'Choose an available handle before adding a passkey.');
  const start = await ctx.runMutation(components.authPasskey.registration.startRegistrationForExistingUser, {
    verifiedUserId: user._id,
  });
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
}
export async function finishRegistration(
  ctx: MutationCtx,
  user: Doc<'users'>,
  response: Infer<typeof registrationResponse>,
) {
  const result = await ctx.runMutation(
    components.authPasskey.registration._internal_dangerous_finishRegistrationForExistingUser,
    {
      expectedRpId: passkeyConfig.rpId,
      expectedOrigin: passkeyConfig.origin,
      verifiedUserId: user._id,
      response,
      name: 'Forge passkey',
    },
  );
  if (result.success)
    await ctx.db.patch(user._id, { passkeyNotice: { at: Date.now(), passkeyId: result.passkeyId } });
  return result;
}
