// SPDX-License-Identifier: Apache-2.0
// The People and access page's one read and its role change (Items b987e608, c6629fda; docs/access.md). The role is
// resolved by convex/projectRole.ts and every answer comes from convex/projectAccessContract.ts; people are named by
// the public identity rule (convex/publicPeople.ts), so a reader sees only themselves and invitation addresses reach
// the owner only. Bounded: at most `limit` write and read members and 50 open invitations per call.
import { v } from 'convex/values';
import { query, accountMutation } from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { projectRole } from './projectRole';
import { projectAnswers, projectRoles } from './projectAccessContract';
import { retainMembership } from './projectActorNames';
import { invitationWasRevoked, type InvitationRevocations } from './projectInvitationRevocation';
import { requireOwnerPerson } from './ownerPerson';
import { effectivePolicy } from '../src/autonomy-policy';
import { invariant } from '../src/errors';
import { report } from './errors';
import { invitationStatus, invitationLifetime, visibleInviteMail } from './projectInvitationPolicy';
import { invitationState } from './projectInvitationFields';
import { syncPersonOrder } from './accountProjectOrder';

const role = v.union(...projectRoles.map(name => v.literal(name)));
const answer = v.union(v.literal('yes'), v.literal('held'), v.literal('no'));
const member = v.object({ person: v.string(), at: v.number() });
const mail = v.object({
  status: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed'), v.literal('off')),
  sends: v.number(),
  at: v.number(),
  code: v.optional(v.string()),
});
const MAX = 500;

export const people = query({
  args: {
    projectId: v.id('hostedProjects'),
    limit: v.optional(v.number()),
    invitationCursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    name: v.string(),
    visibility: v.union(v.literal('public'), v.literal('private')),
    role: v.union(role, v.null()),
    answers: v.record(v.string(), answer),
    owner: v.string(),
    withoutCheck: v.union(v.literal('owner'), v.literal('chosen'), v.literal('writers')),
    write: v.object({ rows: v.array(member), more: v.boolean() }),
    read: v.object({ rows: v.array(member), more: v.boolean() }),
    invitationCursor: v.union(v.string(), v.null()),
    invited: v.array(
      v.object({
        id: v.id('projectInvites'),
        email: v.string(),
        role: v.union(v.literal('read'), v.literal('write')),
        at: v.number(),
        state: invitationState,
        expiresAt: v.number(),
        operationId: v.optional(v.string()),
        mail: v.optional(mail),
      }),
    ),
  }),
  handler: async (ctx, { projectId, limit, invitationCursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to see who can do what.');
      // A private project without a role answers not found here too.
      const project = await accessibleProject(ctx, projectId, user.subject);
      const standing = await projectRole(ctx, project, user.subject);
      const visibility: 'public' | 'private' = project.visibility === 'public' ? 'public' : 'private';
      const answers = projectAnswers(standing ?? 'public', 'person', visibility);
      const take = Math.max(1, Math.min(MAX, Math.floor(limit ?? 50)));
      // Writers and the owner read the roster; a reader reads only their own row (public identity rule).
      const roster = answers.readPeople === 'yes';
      const writers = roster
        ? await ctx.db
            .query('projectContributors')
            .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId))
            .take(take + 1)
        : [];
      const readers = await ctx.db
        .query('projectReaders')
        .withIndex('by_project_and_reader', q =>
          roster ? q.eq('projectId', projectId) : q.eq('projectId', projectId).eq('reader', user.subject),
        )
        .take(roster ? take + 1 : standing === 'read' ? 1 : 0);
      const band = (rows: { person: string; at: number }[]) => ({
        rows: rows.slice(0, take),
        more: rows.length > take,
      });
      const invitations =
        standing === 'owner'
          ? await ctx.db
              .query('projectInvites')
              .withIndex('by_project', q => q.eq('projectId', projectId))
              .order('desc')
              .paginate({ cursor: invitationCursor ?? null, numItems: 50 })
          : null;
      const invites = invitations?.page ?? [];
      const revoked: InvitationRevocations = new Map();
      const invited = await Promise.all(
        invites.map(async row => {
          const mail = visibleInviteMail(row);
          const state = invitationStatus(row);
          const ended =
            state === 'pending' &&
            row.recipient &&
            (await invitationWasRevoked(ctx, row, row.recipient, revoked));
          return {
            id: row._id,
            email: row.email,
            role: row.role ?? ('write' as const),
            at: row._creationTime,
            state: ended ? ('cancelled' as const) : state,
            expiresAt: row.expiresAt ?? row._creationTime + invitationLifetime,
            ...(row.operationId ? { operationId: row.operationId } : {}),
            ...(mail
              ? {
                  mail: {
                    status: mail.status,
                    sends: mail.sends,
                    at: mail.at,
                    ...(mail.code ? { code: mail.code } : {}),
                  },
                }
              : {}),
          };
        }),
      );
      const selection = effectivePolicy(project).acceptance.withoutCheck;
      const withoutCheck: 'owner' | 'chosen' | 'writers' =
        !selection || selection.mode === 'owner'
          ? 'owner'
          : selection.mode === 'writers'
            ? 'writers'
            : 'chosen';
      return {
        name: project.name,
        visibility,
        role: standing,
        answers,
        owner: project.owner,
        withoutCheck,
        write: band(writers.map(row => ({ person: row.contributor, at: row._creationTime }))),
        read: band(readers.map(row => ({ person: row.reader, at: row._creationTime }))),
        invited,
        invitationCursor: invitations?.isDone === false ? invitations.continueCursor : null,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Change a member to write or read, or remove them ('none'). The owner person only, in a browser; retry-safe per
 * operation id. Lowering or removing takes effect on the member's next call and on every call of their agents; their
 * saved work stays. Agents keep the CLI paths (removal open, additions held for the person). */
export const setRole = accountMutation('person')({
  args: {
    projectId: v.id('hostedProjects'),
    person: v.string(),
    role: v.union(v.literal('read'), v.literal('write'), v.literal('none')),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'change who can write');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(input.operationId.trim(), 'BAD_ARGUMENT', 'Retain the role change operation id.');
      const key = `role:${input.role}:${input.person}`;
      const old = await ctx.db
        .query('projectAccessOperations')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.owner === user.subject && old.person === key,
          'WORK_OPERATION_CHANGED',
          'Retry this role change with its original values.',
        );
        return null;
      }
      invariant(input.person !== project.owner, 'BAD_ARGUMENT', 'The owner keeps every right.');
      const current = await projectRole(ctx, project, input.person);
      invariant(
        current === 'write' || current === 'read',
        'BAD_ARGUMENT',
        'This person is not in the project.',
      );
      if (current !== input.role) {
        const contributor = await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', input.projectId).eq('contributor', input.person),
          )
          .unique();
        const reader = await ctx.db
          .query('projectReaders')
          .withIndex('by_project_and_reader', q =>
            q.eq('projectId', input.projectId).eq('reader', input.person),
          )
          .unique();
        if (input.role !== 'write') await retainMembership(ctx, input.projectId, input.person, project.owner);
        if (input.role !== 'write') {
          if (contributor) await ctx.db.delete(contributor._id);
          if (input.role === 'none' && reader) await ctx.db.delete(reader._id);
          if (input.role === 'read' && !reader)
            await ctx.db.insert('projectReaders', { projectId: input.projectId, reader: input.person });
        } else {
          if (reader) await ctx.db.delete(reader._id);
          if (!contributor)
            await ctx.db.insert('projectContributors', {
              projectId: input.projectId,
              contributor: input.person,
            });
        }
        await syncPersonOrder(ctx, input.projectId, input.person);
      }
      await ctx.db.insert('projectAccessOperations', {
        projectId: input.projectId,
        owner: user.subject,
        operationId: input.operationId,
        person: key,
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
