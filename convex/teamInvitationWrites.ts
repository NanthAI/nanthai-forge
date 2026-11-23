// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { accountMutation } from './cliServer';
import type { Id } from './_generated/dataModel';
import { requireOwnerPerson } from './ownerPerson';
import { teamOwner } from './teams';
import { pendingTeamInvitation } from './teamInvitationReads';
import {
  setInvitationBlock,
  invitationBlock,
  recipientEmail,
  recipientEmailProof,
} from './projectInvitationRecipient';
import { assertInvitationTarget, emailShape, invitationBudget } from './projectInvitationPolicy';
import {
  addTeamMembership,
  assertTeamEmailOperation,
  teamInvitationOperation,
  teamEmailOperationKey,
  teamEmailReplay,
  teamInvitationWasRevoked,
} from './teamInvitationMembership';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { report } from './errors';

export const create = internalMutation({
  args: { teamId: v.id('teams'), target: v.string(), operationId: v.optional(v.string()) },
  returns: v.union(v.literal('direct'), v.literal('pending')),
  handler: async (ctx, { teamId, target, operationId }) => {
    const user = await requireOwnerPerson(ctx, 'invite people to a team');
    // The retired direct add trimmed without a raw limit; limit the trimmed address so its exact retries still replay.
    assertInvitationTarget(target.trim());
    const email = target.trim().toLowerCase();
    invariant(emailShape.test(email), 'BAD_ARGUMENT', 'Enter an email address.');
    assertTeamEmailOperation(operationId);
    const team = await teamOwner(ctx, teamId, user.subject);
    const key = teamEmailOperationKey(email, operationId);
    const replay = await teamInvitationOperation(ctx, teamId, key);
    if (replay) {
      const result = teamEmailReplay(replay, email);
      if (!operationId)
        invariant(
          pendingTeamInvitation(replay),
          'BAD_ARGUMENT',
          'This invitation ended. Open People and teams to invite again.',
        );
      return result;
    }
    const [older] = await ctx.db
      .query('projectInvites')
      .withIndex('by_teamId_and_email_and_state', q =>
        q.eq('teamId', teamId).eq('email', email).eq('state', 'pending'),
      )
      .take(1);
    // A pending address has no account binding. No identity-provider request or mail is made here.
    const charge = await invitationBudget(ctx, team.owner);
    await charge();
    if (older) await ctx.db.patch(older._id, { state: 'replaced', endedAt: Date.now() });
    if (team.invitationEpoch === undefined) await ctx.db.patch(teamId, { invitationEpoch: 0 });
    await ctx.db.insert('projectInvites', {
      teamId,
      email,
      target: target.trim(),
      kind: 'email',
      inviter: team.owner,
      state: 'pending',
      operationId: key,
      invitationEpoch: team.invitationEpoch ?? 0,
    });
    return 'pending' as const;
  },
});

/** A Forge handle invitation binds the account but grants nothing until that account accepts on Home. */
export const createForHandle = internalMutation({
  args: { teamId: v.id('teams'), target: v.string(), operationId: v.optional(v.string()) },
  returns: v.union(v.literal('member'), v.literal('pending')),
  handler: async (ctx, { teamId, target, operationId }) => {
    const user = await requireOwnerPerson(ctx, 'invite people to a team');
    const typed = target.trim();
    assertInvitationTarget(typed);
    invariant(typed, 'BAD_ARGUMENT', 'Enter a Forge handle.');
    assertTeamEmailOperation(operationId);
    const team = await teamOwner(ctx, teamId, user.subject);
    const handleOf = (value: string) => value.toLowerCase().replace(/^@/, '');
    // The public wrapper turns an exact bare handle into its account id; `@handle` arrives as typed.
    // An explicit retry answers from its retained row first, so a later rename or membership change cannot alter it.
    if (operationId) {
      const replay = await teamInvitationOperation(ctx, teamId, operationId);
      if (replay) {
        invariant(
          replay.kind === 'handle' &&
            (handleOf(replay.target ?? '') === handleOf(typed) || replay.recipient === typed),
          'WORK_OPERATION_CHANGED',
          'Retry the original team invitation.',
        );
        return 'pending' as const;
      }
    }
    const handle = handleOf(typed);
    const account =
      (/^[a-z0-9][a-z0-9-]*$/.test(handle)
        ? await ctx.db
            .query('forgeAccounts')
            .withIndex('by_handle', q => q.eq('handle', handle))
            .unique()
        : null) ??
      (await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', typed))
        .unique());
    const member = (person: string) =>
      ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', teamId).eq('member', person))
        .unique();
    // A current member (the owner, or an original direct add retried by its account id) replays: no grant, charge or row.
    // Direct adds kept no receipt, so a retry after the member left is a new request: a pending invitation.
    if (!account?.handle) {
      invariant(await member(typed), 'BAD_ARGUMENT', 'No Forge account has that handle.');
      return 'member' as const;
    }
    if (account.owner === team.owner || (await member(account.owner))) return 'member' as const;
    const key = operationId ?? 'team-handle:' + account.owner;
    if (!operationId) {
      const replay = await teamInvitationOperation(ctx, teamId, key);
      if (replay) {
        invariant(
          pendingTeamInvitation(replay),
          'BAD_ARGUMENT',
          'This invitation ended. Send a new invitation with a new operation id.',
        );
        return 'pending' as const;
      }
    }
    // Never store an account id as the owner's typed target: a bare handle arrives resolved.
    const shown = account.owner === typed ? account.handle : typed;
    const [older] = await ctx.db
      .query('projectInvites')
      .withIndex('by_teamId_and_email_and_state', q =>
        q
          .eq('teamId', teamId)
          .eq('email', '@' + account.handle)
          .eq('state', 'pending'),
      )
      .take(1);
    const charge = await invitationBudget(ctx, team.owner);
    await charge();
    if (older) await ctx.db.patch(older._id, { state: 'replaced', endedAt: Date.now() });
    if (team.invitationEpoch === undefined) await ctx.db.patch(teamId, { invitationEpoch: 0 });
    await ctx.db.insert('projectInvites', {
      teamId,
      email: '@' + account.handle,
      target: shown,
      kind: 'handle',
      inviter: team.owner,
      recipient: account.owner,
      state: 'pending',
      operationId: key,
      invitationEpoch: team.invitationEpoch ?? 0,
    });
    return 'pending' as const;
  },
});

export const teamInvitationAnswerArgs = {
  invitationId: v.id('projectInvites'),
  operationId: v.string(),
  choice: v.union(v.literal('accept'), v.literal('decline'), v.literal('block')),
};

async function teamInvitationAnswer(
  ctx: QueryCtx | MutationCtx,
  {
    invitationId,
    operationId,
    choice,
  }: {
    invitationId: Id<'projectInvites'>;
    operationId: string;
    choice: 'accept' | 'decline' | 'block';
  },
) {
  const user = await requireOwnerPerson(ctx, 'answer team invitations');
  const row = await ctx.db.get(invitationId);
  invariant(row?.teamId && !row.projectId, 'PROJECT_UNAVAILABLE', 'This team invitation is unavailable.');
  invariant(operationId.trim(), 'BAD_ARGUMENT', 'Retain the team invitation answer operation id.');
  const answerId = digest(operationId);
  if (row.answer?.operationId === answerId && row.answer.person === user.subject) {
    invariant(
      row.answer.choice === choice,
      'WORK_OPERATION_CHANGED',
      'Retry the original invitation answer.',
    );
    return null;
  }
  // A handle invitation is bound to its account; an address one to the current verified address.
  const handle = row.kind === 'handle';
  const proof = handle ? null : await recipientEmailProof(ctx, user);
  invariant(
    handle ? row.recipient === user.subject : proof?.email === row.email,
    'PROJECT_UNAVAILABLE',
    'This team invitation is unavailable.',
  );
  invariant(
    pendingTeamInvitation(row) && !(await teamInvitationWasRevoked(ctx, row, user.subject)),
    'BAD_ARGUMENT',
    'This team invitation ended. Ask for a new invitation.',
  );
  const team = await ctx.db.get(row.teamId);
  invariant(
    team && !team.removal && team.owner === row.inviter,
    'PROJECT_UNAVAILABLE',
    'This team invitation is unavailable.',
  );
  const block = await invitationBlock(ctx, user.subject, team.owner);
  invariant(choice !== 'accept' || !block?.blocked, 'BAD_ARGUMENT', 'Unblock the inviter before accepting.');
  return { row, team, user, proof, block, answerId };
}

export const prepareAccept = internalQuery({
  args: teamInvitationAnswerArgs,
  returns: v.union(
    v.null(),
    v.literal('handle'),
    v.object({ email: v.string(), native: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, input) => {
    const result = await teamInvitationAnswer(ctx, input);
    if (!result) return null;
    return result.proof ?? ('handle' as const);
  },
});

export const answer = internalMutation({
  args: { ...teamInvitationAnswerArgs, providerSubject: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const result = await teamInvitationAnswer(ctx, input);
    if (!result) return null;
    const { row, team, user, block, answerId } = result;
    if (input.choice === 'accept') {
      invariant(
        row.kind === 'handle' || input.providerSubject === user.subject,
        'PROJECT_UNAVAILABLE',
        'This team invitation is unavailable.',
      );
      await addTeamMembership(ctx, team._id, user.subject);
    }
    if (input.choice === 'block')
      await setInvitationBlock(
        ctx,
        user.subject,
        team.owner,
        block,
        // As for project handle blocks: the verified address lets the same preference suppress later mail.
        row.kind === 'handle' ? await recipientEmail(ctx, user, { anyAge: true }) : row.email,
      );
    await ctx.db.patch(row._id, {
      state: input.choice === 'accept' ? 'accepted' : 'declined',
      endedAt: Date.now(),
      answer: { operationId: answerId, choice: input.choice, person: user.subject },
    });
    return null;
  },
});

export const cancel = accountMutation('person')({
  args: { teamId: v.id('teams'), invitationId: v.id('projectInvites'), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { teamId, invitationId, operationId }) => {
    try {
      const user = await requireOwnerPerson(ctx, 'cancel team invitations');
      await teamOwner(ctx, teamId, user.subject);
      const row = await ctx.db.get(invitationId);
      invariant(
        row?.teamId === teamId && !row.projectId,
        'PROJECT_UNAVAILABLE',
        'This team invitation is unavailable.',
      );
      invariant(operationId.trim(), 'BAD_ARGUMENT', 'Retain the team invitation cancellation operation id.');
      const answerId = digest(operationId);
      if (row.answer?.operationId === answerId && row.answer.person === user.subject) {
        invariant(
          row.answer.choice === 'cancel',
          'WORK_OPERATION_CHANGED',
          'Retry the original cancellation.',
        );
        return null;
      }
      invariant(pendingTeamInvitation(row), 'BAD_ARGUMENT', 'This team invitation already ended.');
      await ctx.db.patch(row._id, {
        state: 'cancelled',
        endedAt: Date.now(),
        answer: { operationId: answerId, person: user.subject, choice: 'cancel' },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
