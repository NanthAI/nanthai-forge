// SPDX-License-Identifier: Apache-2.0
import type { UserIdentity } from 'convex/server';
import type { MutationCtx, QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { findVerifiedRecipient } from './authUsers';
import { invariant, ForgeError } from '../src/errors';
import { isDeviceIdentity } from './cliServer';
import { invitationEmailHash } from './projectInvitationPolicy';

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
