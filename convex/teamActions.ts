// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { action } from './cliServer';
import { personByEmail, personLabel } from './projectPeople';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { currentAccess } from './access';
import { checkForgeUser } from './sharingActions';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';

export const addMember = action({
  args: { id: v.id('teams'), member: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, member }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      await ctx.runQuery(internal.teams.owned, { id, owner: user.subject });
      member = await checkForgeUser(member);
      return await ctx.runMutation(internal.teams.add, { id, owner: user.subject, member });
    } catch (error) {
      return report(error);
    }
  },
});
export const codescapes = action({
  args: { id: v.id('teams'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ id: v.id('imports'), repository: v.string(), ref: v.string(), phase: v.string() }),
  ),
  handler: async (
    ctx,
    { id, paginationOpts },
  ): Promise<{
    page: { id: Id<'imports'>; repository: string; ref: string; phase: string }[];
    isDone: boolean;
    continueCursor: string;
  }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to explore a team.');
      const candidates: { page: Id<'imports'>[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.teams.candidates, { id, member: user.subject, paginationOpts });
      const page = [];
      for (const importId of candidates.page) {
        try {
          const { job } = await currentAccess(ctx, importId, user.subject);
          if (await ctx.runQuery(internal.teams.linked, { id, importId, member: user.subject }))
            page.push({ id: job._id, repository: job.repository, ref: job.ref, phase: job.phase });
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
        }
      }
      // Recheck the selected team's membership, even if a separate named grant still authorizes source.
      await ctx.runQuery(internal.teams.candidates, {
        id,
        member: user.subject,
        paginationOpts: { numItems: 1, cursor: null },
      });
      return { ...candidates, page };
    } catch (error) {
      return report(error);
    }
  },
});

export const addByEmail = action({
  args: { id: v.id('teams'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, email }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      await ctx.runQuery(internal.teams.owned, { id, owner: user.subject });
      const person = await personByEmail(email);
      return await ctx.runMutation(internal.teams.add, { id, owner: user.subject, member: person.id });
    } catch (error) {
      return report(error);
    }
  },
});
export const labels = action({
  args: { id: v.id('teams'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ member: v.string(), label: v.string() })),
  handler: async (
    ctx,
    args,
  ): Promise<{ page: { member: string; label: string }[]; isDone: boolean; continueCursor: string }> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to manage a team.');
      const rows = await ctx.runQuery(api.teams.members, args);
      const page = await Promise.all(
        rows.page.map(async row => ({ member: row.member, label: await personLabel(row.member) })),
      );
      await ctx.runQuery(internal.teams.owned, { id: args.id, owner: user.subject });
      const current = await ctx.runQuery(api.teams.members, args);
      return { ...rows, page: page.filter(row => current.page.some(member => member.member === row.member)) };
    } catch (error) {
      return report(error);
    }
  },
});
