// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { accountMutation } from './cliServer';
import { requireOwnerPerson } from './ownerPerson';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { report } from './errors';
import {
  invitationPerson,
  isInvitationRecipient,
  invitationBlock,
  recipientEmail,
  setInvitationBlock,
} from './projectInvitationRecipient';
import { invitationStatus } from './projectInvitationPolicy';
import { syncPersonOrder } from './accountProjectOrder';
import { invitationInviter, invitationWasRevoked } from './projectInvitationRevocation';

/** Acceptance is the sole invitation grant path; an existing write grant is never lowered. */
async function grant(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  person: string,
  role: 'read' | 'write',
) {
  const writer = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', person))
    .unique();
  if (writer) return;
  const reader = await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q => q.eq('projectId', projectId).eq('reader', person))
    .unique();
  if (role === 'read') {
    if (!reader) await ctx.db.insert('projectReaders', { projectId, reader: person });
  } else {
    if (reader) await ctx.db.delete(reader._id);
    await ctx.db.insert('projectContributors', { projectId, contributor: person });
  }
  // Account > Projects order row in the same transaction (Item 3d5d8839).
  await syncPersonOrder(ctx, projectId, person);
}
export const answer = accountMutation('person')({
  args: {
    invitationId: v.id('projectInvites'),
    operationId: v.string(),
    choice: v.union(v.literal('accept'), v.literal('decline'), v.literal('block')),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'answer invitations');
      const row = await ctx.db.get(input.invitationId);
      invariant(
        row?.projectId && !row.teamId,
        'PROJECT_UNAVAILABLE',
        'Invitation unavailable for this account. Open your invitations with the invited account.',
      );
      invariant(input.operationId.trim(), 'BAD_ARGUMENT', 'Retain the invitation answer operation id.');
      if (row.answer?.operationId === input.operationId && row.answer.person === user.subject) {
        invariant(
          row.answer.choice === input.choice,
          'WORK_OPERATION_CHANGED',
          'Retry your original invitation answer.',
        );
        return null;
      }
      invariant(
        await isInvitationRecipient(ctx, row, user),
        'PROJECT_UNAVAILABLE',
        'Invitation unavailable for this account. Open your invitations with the invited account.',
      );
      invariant(
        invitationStatus(row) === 'pending' && !(await invitationWasRevoked(ctx, row, user.subject)),
        'BAD_ARGUMENT',
        'This invitation has ended. Ask for a new invitation.',
      );
      const project = await ctx.db.get(row.projectId);
      invariant(
        project && !project.removal && (await invitationInviter(ctx, row)) === project.owner,
        'PROJECT_UNAVAILABLE',
        'Invitation unavailable.',
      );
      const blocked = await invitationBlock(ctx, user.subject, project.owner);
      invariant(
        input.choice !== 'accept' || !blocked?.blocked,
        'BAD_ARGUMENT',
        'Invitations from this account are blocked. Unblock it in your invitations first.',
      );
      if (input.choice === 'accept' && project.owner !== user.subject)
        await grant(ctx, row.projectId, user.subject, row.role ?? 'write');
      if (input.choice === 'block') {
        const address = row.recipient ? await recipientEmail(ctx, user, { anyAge: true }) : row.email;
        await setInvitationBlock(ctx, user.subject, project.owner, blocked, address);
      }
      await ctx.db.patch(row._id, {
        state: input.choice === 'accept' ? 'accepted' : 'declined',
        endedAt: Date.now(),
        answer: { operationId: input.operationId, choice: input.choice, person: user.subject },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const unblock = accountMutation('person')({
  args: { id: v.id('invitationBlocks'), operationId: v.string(), expectedVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, operationId, expectedVersion }) => {
    const user = await invitationPerson(ctx),
      row = await ctx.db.get(id);
    invariant(
      operationId.trim() && row?.recipient === user.subject,
      'PROJECT_UNAVAILABLE',
      'Invitation preference unavailable.',
    );
    if (row.unblockOperation === operationId) return null;
    invariant(
      (row.version ?? 0) === expectedVersion,
      'WORK_OPERATION_CHANGED',
      'This invitation preference has changed. Read it again.',
    );
    if (row.blocked)
      await ctx.db.patch(id, { blocked: false, version: expectedVersion + 1, unblockOperation: operationId });
    return null;
  },
});
