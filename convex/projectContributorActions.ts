// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { api, internal } from './_generated/api';
import { checkForgeUser } from './sharingActions';
import { caller } from './projectWorkActions';
import { personByEmail, personLabel, findPersonByEmail } from './projectPeople';
import { invariant } from '../src/errors';
import { report } from './errors';
export const add = action({
  args: { projectId: v.id('hostedProjects'), contributor: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, contributor }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      contributor = await checkForgeUser(contributor);
      return await ctx.runMutation(internal.projectContributors.add, { projectId, owner, contributor });
    } catch (error) {
      return report(error);
    }
  },
});

// Preserve the original ID-based integration API. The people UI uses exact email lookup.
export const addByEmail = action({
  args: { projectId: v.id('hostedProjects'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, email }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      const person = await personByEmail(email);
      return await ctx.runMutation(internal.projectContributors.add, {
        projectId,
        owner,
        contributor: person.id,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const labels = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.array(v.object({ contributor: v.string(), label: v.string(), handle: v.optional(v.string()) })),
  handler: async (ctx, { projectId }): Promise<{ contributor: string; label: string; handle?: string }[]> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      const rows = await ctx.runQuery(api.projectContributors.list, { projectId });
      const labels = await Promise.all(
        rows.map(async row => {
          const identity = await ctx.runQuery(internal.projectContributors.identity, {
            projectId,
            owner,
            contributor: row.contributor,
          });
          return {
            contributor: row.contributor,
            label: await personLabel(row.contributor),
            ...(identity ? { handle: identity.handle } : {}),
          };
        }),
      );
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      const current = await ctx.runQuery(api.projectContributors.list, { projectId });
      return labels.filter(person => current.some(row => row.contributor === person.contributor));
    } catch (error) {
      return report(error);
    }
  },
});

export const invitePerson = action({
  args: { projectId: v.id('hostedProjects'), person: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, person, operationId }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      person = person.trim().toLowerCase();
      const request = { projectId, owner, person, operationId };
      if (await ctx.runQuery(internal.projectContributors.invitationOperation, request)) return null;
      if (person.startsWith('@')) {
        const account = await ctx.runQuery(internal.projectContributors.identity, {
          projectId,
          owner,
          handle: person.trim().slice(1).toLowerCase(),
        });
        invariant(account, 'BAD_ARGUMENT', 'No Forge account has that handle.');
        return await ctx.runMutation(internal.projectContributors.invite, {
          ...request,
          contributor: account.owner,
        });
      }
      const account = await findPersonByEmail(person);
      if (account)
        return await ctx.runMutation(internal.projectContributors.invite, {
          ...request,
          contributor: account.id,
        });
      return await ctx.runMutation(internal.projectContributors.invite, {
        ...request,
        email: person.trim().toLowerCase(),
      });
    } catch (error) {
      return report(error);
    }
  },
});
