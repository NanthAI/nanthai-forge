// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Adding and removing passkeys (Item 702af738). The auth library's own add and remove flows first ask for a sign-in
// (`navigator.credentials.get()`) with an existing passkey of the account. A passkey made on an earlier site address
// belongs to another relying party, so no authenticator on this address can answer that request: Safari falls back
// to the phone QR code and a phone answers it as a sign-in, which fails; removal is refused the same way. Here the
// proof is any recent sign-in of this browser instead: a new session, or the ten-minute proof that a passkey or
// GitHub check of this account records for it (convex/authDeviceFresh.ts, authSessions.confirmDeviceApproval).
import { v } from 'convex/values';
import { creationOptions, registrationResponse, registrationResult } from './authPasskeyWire';
import { startRegistration, finishRegistration } from './authPasskeyRegistration';
import { accountMutation } from './cliServer';
import { authComponents as components } from './authComponents';
import { linkAccount } from './authLinkAccount';
import { invariant } from '../src/errors';
import type { MutationCtx } from './server';

const FRESH_SESSION_MS = 10 * 60 * 1000;
/** The library's cap: every passkey goes into each sign-in's allow list and each registration's exclude list. */
const MAX_PASSKEYS = 20;

/** The signed-in account, only while this browser holds a proof under ten minutes old. */
async function provenAccount(ctx: MutationCtx) {
  const { user, sessionId } = await linkAccount(ctx);
  const now = Date.now();
  const proof = user.deviceApprovalProof;
  if (proof?.sessionId === sessionId && proof.verifiedUntil > now) return user;
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
  const current = sessions.find(session => session.sessionId === sessionId);
  invariant(
    current && now - current.creationTime <= FRESH_SESSION_MS,
    'AUTH_EXPIRED',
    'Confirm it is you with GitHub or a passkey, then try again.',
  );
  return user;
}
const passkeysOf = (ctx: MutationCtx, userId: string) =>
  ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId });

const underCap = (count: number) =>
  invariant(
    count < MAX_PASSKEYS,
    'QUOTA_EXCEEDED',
    `An account holds at most ${MAX_PASSKEYS} passkeys. Remove one first.`,
  );
export const start = accountMutation('same')({
  args: {},
  returns: creationOptions,
  handler: async ctx => {
    const user = await provenAccount(ctx);
    underCap((await passkeysOf(ctx, user._id)).length);
    return startRegistration(ctx, user);
  },
});
/** Stores the new passkey. A repeat of a finish that already stored this credential answers with that passkey, so a
 * lost reply reconciles; the cap is checked again here, in the transaction that stores it. */
export const finish = accountMutation('same')({
  args: { response: registrationResponse },
  returns: registrationResult,
  handler: async (ctx, { response }) => {
    const user = await provenAccount(ctx);
    const passkeys = await passkeysOf(ctx, user._id);
    const stored = passkeys.find(key => key.credentialId === response.id);
    if (stored) return { success: true as const, passkeyId: stored.passkeyId };
    underCap(passkeys.length);
    return finishRegistration(ctx, user, response);
  },
});

/** Removes one passkey. The account keeps a way in: another passkey or its linked GitHub identity. Removing a
 * passkey that is already gone succeeds, so a retry after an unknown outcome reconciles. */
export const remove = accountMutation('same')({
  args: { passkeyId: v.string() },
  returns: v.null(),
  handler: async (ctx, { passkeyId }) => {
    const user = await provenAccount(ctx);
    const passkeys = await passkeysOf(ctx, user._id);
    if (!passkeys.some(key => key.passkeyId === passkeyId)) return null;
    invariant(
      passkeys.length > 1 || (user.githubId && !user.githubConflict),
      'BAD_ARGUMENT',
      'This is your only way in. Add another passkey or link GitHub before removing it.',
    );
    const deleted = await ctx.runMutation(components.authPasskey.registration.deletePasskey, {
      userId: user._id,
      passkeyId,
    });
    invariant(deleted.success, 'BAD_ARGUMENT', 'Forge could not remove that passkey.');
    return null;
  },
});
