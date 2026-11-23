// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { accountAction } from './cliServer';
import { teamInvitationAnswerArgs } from './teamInvitationWrites';
import { assertTeamEmailOperation } from './teamInvitationMembership';
import { api, internal } from './_generated/api';
import { invariant } from '../src/errors';
import { report } from './errors';

export const addMember = accountAction('person')({
  args: { id: v.id('teams'), member: v.string(), operationId: v.optional(v.string()) },
  returns: v.union(v.null(), v.literal('pending')),
  handler: async (ctx, { id, member, operationId }): Promise<null | 'pending'> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      // A handle never becomes membership here: it stays pending until that account accepts on Home.
      const result = await ctx.runMutation(internal.teamInvitationWrites.createForHandle, {
        teamId: id,
        target: member,
        ...(operationId === undefined ? {} : { operationId }),
      });
      return operationId !== undefined && result === 'pending' ? 'pending' : null;
    } catch (error) {
      return report(error);
    }
  },
});

export const addByEmail = accountAction('person')({
  args: {
    id: v.id('teams'),
    email: v.string(),
    operationId: v.optional(v.string()),
    // Older browsers still send this; every address invitation is pending now.
    pending: v.optional(v.literal(true)),
  },
  returns: v.union(v.null(), v.literal('pending')),
  handler: async (ctx, { id, email, operationId }): Promise<null | 'pending'> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      assertTeamEmailOperation(operationId);
      // An address never becomes membership here: it stays pending until its verified owner accepts on Home.
      const result = await ctx.runMutation(internal.teamInvitationWrites.create, {
        teamId: id,
        target: email,
        ...(operationId === undefined ? {} : { operationId }),
      });
      return operationId !== undefined && result === 'pending' ? 'pending' : null;
    } catch (error) {
      return report(error);
    }
  },
});
export const answerInvitation = accountAction('person')({
  args: teamInvitationAnswerArgs,
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    try {
      if (input.choice !== 'accept')
        return await ctx.runMutation(internal.teamInvitationWrites.answer, input);
      const proof = await ctx.runQuery(internal.teamInvitationWrites.prepareAccept, input);
      if (!proof) return null;
      if (proof === 'handle') return await ctx.runMutation(internal.teamInvitationWrites.answer, input);
      // Only the account that holds the verified address can accept; no other sign-in is consulted.
      invariant(proof.native, 'BAD_ARGUMENT', 'No Forge account matches that email address.');
      return await ctx.runMutation(internal.teamInvitationWrites.answer, {
        ...input,
        providerSubject: proof.native,
      });
    } catch (error) {
      return report(error);
    }
  },
});

export const labels = accountAction('same')({
  args: { id: v.id('teams'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ member: v.string(), label: v.string() })),
  handler: async (
    ctx,
    args,
  ): Promise<{ page: { member: string; label: string }[]; isDone: boolean; continueCursor: string }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      await ctx.runQuery(internal.teams.owned, { id: args.id, owner: user.subject });
      // The public member list already names each member by handle; that handle is the label.
      const rows = await ctx.runQuery(api.teams.members, args);
      return { ...rows, page: rows.page.map(row => ({ member: row.member, label: row.member })) };
    } catch (error) {
      return report(error);
    }
  },
});
