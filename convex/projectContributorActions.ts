// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { api, internal } from './_generated/api';
import { checkForgeUser } from './sharingActions';
import { caller } from './projectWorkActions';
import { digest } from '../src/state/hash';
import { report } from './errors';
import { requestMemberApproval } from './projectMemberRequest';
export const add = action({
  args: { projectId: v.id('hostedProjects'), contributor: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, contributor }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      contributor = await checkForgeUser(contributor);
      if (await requestMemberApproval(ctx, projectId, { kind: 'contributor', contributor })) return null;
      return await ctx.runMutation(internal.projectContributors.add, { projectId, owner, contributor });
    } catch (error) {
      return report(error);
    }
  },
});

// Preserve the original integration API. The People UI uses explicit invitation operation ids.
export const addByEmail = action({
  args: { projectId: v.id('hostedProjects'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, email }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      const person = email.trim().toLowerCase();
      const operationId = digest(JSON.stringify(['email-invite', projectId, owner, person]));
      if (
        await requestMemberApproval(
          ctx,
          projectId,
          { kind: 'invite', person, operationId, email: person },
          operationId,
        )
      )
        return null;
      return await ctx.runMutation(internal.projectContributors.invite, {
        projectId,
        owner,
        person,
        operationId,
        email: person,
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
      // The public list already names each contributor by handle; that handle is the label.
      const rows = await ctx.runQuery(api.projectContributors.list, { projectId });
      return rows.map(row => ({
        contributor: row.contributor,
        label: row.contributor,
        ...(row.contributor ? { handle: row.contributor } : {}),
      }));
    } catch (error) {
      return report(error);
    }
  },
});

export const invitePerson = action({
  args: {
    projectId: v.id('hostedProjects'),
    person: v.string(),
    operationId: v.string(),
    role: v.optional(v.union(v.literal('read'), v.literal('write'))),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, person, operationId, role }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId, owner });
      person = person.trim().toLowerCase();
      const request = { projectId, owner, person, operationId, ...(role ? { role } : {}) };
      if (
        await requestMemberApproval(
          ctx,
          projectId,
          { kind: 'invite', person, operationId, ...(role ? { role } : {}) },
          operationId,
        )
      )
        return null;
      return await ctx.runMutation(internal.projectContributors.invite, request);
    } catch (error) {
      return report(error);
    }
  },
});
