// SPDX-License-Identifier: Apache-2.0
import type { UserIdentity } from 'convex/server';
import type { MutationCtx, QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { findVerifiedRecipient } from './authUsers';
import { invariant, ForgeError } from '../src/errors';
import { isDeviceIdentity } from './cliServer';

export async function invitationPerson(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user && !isDeviceIdentity(user), 'AUTH_REQUIRED', 'Sign in to answer your invitations in Forge.');
  return user;
}
export async function recipientEmail(ctx: QueryCtx | MutationCtx, user: UserIdentity) {
  if (!user.emailVerified || !user.email) return null;
  const email = user.email.trim().toLowerCase();
  // Ambiguous native bindings never authorize acceptance, including a legacy session.
  try {
    const current = await findVerifiedRecipient(ctx, email);
    if ((current && current !== user.subject) || (user.forgeAuthUser && current !== user.subject))
      return null;
    return email;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'BAD_ARGUMENT') return null;
    throw error;
  }
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
