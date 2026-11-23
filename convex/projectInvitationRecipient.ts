// SPDX-License-Identifier: Apache-2.0
import type { UserIdentity } from 'convex/server';
import type { MutationCtx, QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { findVerifiedRecipient } from './authUsers';
import { invariant, ForgeError } from '../src/errors';
import { isDeviceIdentity } from './cliServer';
import { invitationEmailHash } from './projectInvitationPolicy';
import { invitationWasRevoked } from './projectInvitationRevocation';

export async function invitationPerson(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user && !isDeviceIdentity(user), 'AUTH_REQUIRED', 'Sign in to answer your invitations in Forge.');
  return user;
}
/** `anyAge` only where nothing is granted (the block step); see findVerifiedRecipient. */
export async function recipientEmailProof(
  ctx: QueryCtx | MutationCtx,
  user: UserIdentity,
  options: { anyAge?: boolean } = {},
) {
  if (!user.emailVerified || !user.email) return null;
  const email = user.email.trim().toLowerCase();
  // Ambiguous native bindings never authorize acceptance, including a legacy session.
  try {
    const current = await findVerifiedRecipient(ctx, email, options);
    if ((current && current !== user.subject) || (user.forgeAuthUser && current !== user.subject))
      return null;
    return { email, native: current };
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'BAD_ARGUMENT') return null;
    throw error;
  }
}
export async function recipientEmail(
  ctx: QueryCtx | MutationCtx,
  user: UserIdentity,
  options: { anyAge?: boolean } = {},
) {
  return (await recipientEmailProof(ctx, user, options))?.email ?? null;
}
export async function isInvitationRecipient(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'projectInvites'>,
  user: UserIdentity,
) {
  return row.recipient ? row.recipient === user.subject : (await recipientEmail(ctx, user)) === row.email;
}
export const invitationBlock = (ctx: QueryCtx | MutationCtx, recipient: string, inviter: string) =>
  ctx.db
    .query('invitationBlocks')
    .withIndex('by_recipient_and_inviter', q => q.eq('recipient', recipient).eq('inviter', inviter))
    .unique();

/** Accounts checked for suppression on one address. Granting needs a unique match
 * (findVerifiedRecipient); protection holds for every verified account on the address (review F5). */
const suppressionAccounts = 5;
/** Whether this inviter's mail to this address is suppressed: blocked by address or account, or the
 * recipient was removed after this invitation. Never shown to the inviter; the queue and the send use
 * this one check so they cannot disagree. Every read runs whatever the answer, so the work does not
 * depend on the outcome (P1-02). */
export async function invitationMailSuppressed(
  ctx: QueryCtx | MutationCtx,
  person: string,
  inviter: string,
  invite: Pick<Doc<'projectInvites'>, 'projectId' | 'invitationEpoch'>,
) {
  const address = person.trim().toLowerCase();
  const block = await ctx.db
    .query('invitationBlocks')
    .withIndex('by_email_and_inviter', q =>
      q.eq('emailHash', invitationEmailHash(address)).eq('inviter', inviter).eq('blocked', true),
    )
    .take(1);
  // Suppression is a protection, not a grant: an old address still finds its blocks, and an
  // ambiguous address keeps every bound account's protections.
  const accounts = (
    await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', address))
      .take(suppressionAccounts)
  ).filter(row => row.emailVerified && row.email === address);
  let suppressed = block.some(value => value.blocked);
  for (const { accountKey } of accounts) {
    const accountBlock = await invitationBlock(ctx, accountKey, inviter);
    const removed = await invitationWasRevoked(ctx, invite, accountKey);
    suppressed ||= accountBlock?.blocked === true || removed;
  }
  return suppressed;
}

export async function setInvitationBlock(
  ctx: MutationCtx,
  recipient: string,
  inviter: string,
  blocked: Doc<'invitationBlocks'> | null,
  address: string | null,
) {
  const emailHash = address ? invitationEmailHash(address) : blocked?.emailHash;
  if (blocked)
    await ctx.db.patch(blocked._id, {
      blocked: true,
      version: (blocked.version ?? 0) + 1,
      ...(emailHash ? { emailHash } : {}),
    });
  else
    await ctx.db.insert('invitationBlocks', {
      recipient,
      inviter,
      blocked: true,
      version: 1,
      ...(emailHash ? { emailHash } : {}),
    });
}
