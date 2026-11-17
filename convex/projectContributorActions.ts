// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { api, internal } from './_generated/api';
import { checkForgeUser } from './sharingActions';
import { caller } from './projectWorkActions';
import { emailRecipient } from './projectPeople';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
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

// Preserve the original ID-based integration API. The people UI uses exact email lookup.
export const addByEmail = action({
  args: { projectId: v.id('hostedProjects'), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, email }): Promise<null> => {
    try {
      const owner = await caller(ctx);
      const recipient = await ctx.runQuery(internal.projectContributors.recipient, {
        projectId,
        owner,
        email,
      });
      const person = (await emailRecipient(email, recipient, true))!;
      if (
        await requestMemberApproval(
          ctx,
          projectId,
          recipient
            ? {
                kind: 'contributor',
                contributor: person.id,
                email,
              }
            : {
                // The existing invitation form retains a legacy email without mislabelling it native.
                kind: 'invite',
                person: email.trim().toLowerCase(),
                contributor: person.id,
                operationId: digest(
                  JSON.stringify(['email-member', projectId, owner, email.trim().toLowerCase(), person.id]),
                ),
              },
        )
      )
        return null;
      return await ctx.runMutation(internal.projectContributors.add, {
        projectId,
        owner,
        contributor: person.id,
        ...(recipient ? { email } : { legacyEmail: email }),
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
      const lookup = await ctx.runQuery(internal.projectContributors.invitationOperation, {
        ...request,
        resolveRecipient: true,
      });
      if (typeof lookup === 'boolean' ? lookup : lookup.seen) return null;
      if (person.startsWith('@')) {
        const account = await ctx.runQuery(internal.projectContributors.identity, {
          projectId,
          owner,
          handle: person.trim().slice(1).toLowerCase(),
        });
        invariant(account, 'BAD_ARGUMENT', 'No Forge account has that handle.');
        if (
          await requestMemberApproval(
            ctx,
            projectId,
            { kind: 'invite', person, operationId, ...(role ? { role } : {}), contributor: account.owner },
            operationId,
          )
        )
          return null;
        return await ctx.runMutation(internal.projectContributors.invite, {
          ...request,
          contributor: account.owner,
        });
      }
      const native = typeof lookup === 'object' ? lookup.recipient : null;
      const account = await emailRecipient(person, native);
      if (account) {
        if (
          await requestMemberApproval(
            ctx,
            projectId,
            {
              kind: 'invite',
              person,
              operationId,
              ...(role ? { role } : {}),
              contributor: account.id,
              ...(native ? { email: person } : {}),
            },
            operationId,
          )
        )
          return null;
        return await ctx.runMutation(internal.projectContributors.invite, {
          ...request,
          contributor: account.id,
          ...(native ? { email: person } : {}),
        });
      }
      if (
        await requestMemberApproval(
          ctx,
          projectId,
          { kind: 'invite', person, operationId, ...(role ? { role } : {}), email: person },
          operationId,
        )
      )
        return null;
      return await ctx.runMutation(internal.projectContributors.invite, {
        ...request,
        email: person.trim().toLowerCase(),
      });
    } catch (error) {
      return report(error);
    }
  },
});
