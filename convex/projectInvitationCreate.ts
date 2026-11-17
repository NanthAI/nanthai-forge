// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { activeOwnedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { queueInviteMail } from './projectInviteMail';
import {
  checkOpenEmailInvitations,
  emailShape,
  invitationBudget,
  invitationEmailEnabled,
  invitationLifetime,
  invitationStatus,
  invitationByOperation,
  legacyEmailInvitationOperation,
  assertInvitationTarget,
} from './projectInvitationPolicy';
import { invitationEpoch, invitationWasRevoked } from './projectInvitationRevocation';

export async function assertLegacyInvitationOpen(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const row = await invitationByOperation(ctx, projectId, operationId);
  invariant(
    row &&
      invitationStatus(row) === 'pending' &&
      (!row.recipient || !(await invitationWasRevoked(ctx, row, row.recipient))),
    'BAD_ARGUMENT',
    'This earlier invitation has ended. Send a new invitation in People with a new operation id.',
  );
}

export async function createInvitation(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    operationId: string;
    person: string;
    role?: 'read' | 'write';
    email?: string;
    contributor?: string;
    explainEnded?: boolean;
  },
): Promise<null> {
  assertInvitationTarget(input.person);
  const { projectId, owner, operationId } = input;
  const person = input.person.trim().toLowerCase(),
    role = input.role ?? 'write';
  await activeOwnedProject(ctx, projectId, owner);
  invariant(operationId.trim(), 'BAD_ARGUMENT', 'Retain the invitation operation id.');
  const original = await ctx.db
    .query('projectAccessOperations')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  if (original) {
    if (input.explainEnded || operationId === legacyEmailInvitationOperation(projectId, owner, person))
      await assertLegacyInvitationOpen(ctx, projectId, operationId);
    invariant(
      original.owner === owner && original.person === person && (original.role ?? 'write') === role,
      'WORK_OPERATION_CHANGED',
      'Retry the original invitation with its original role.',
    );
    return null;
  }
  const isEmail = emailShape.test(person);
  invariant(
    isEmail || /^@[a-z0-9][a-z0-9-]*$/.test(person),
    'BAD_ARGUMENT',
    'Enter a Forge handle or email address.',
  );
  // No email lookup: existing and unknown addresses take exactly the same path.
  let recipient: string | undefined;
  if (!isEmail) {
    const account = await ctx.db
      .query('forgeAccounts')
      .withIndex('by_handle', q => q.eq('handle', person.slice(1)))
      .unique();
    invariant(account, 'BAD_ARGUMENT', 'No Forge account has that handle.');
    recipient = account.owner;
  } else {
    const user = await ctx.auth.getUserIdentity();
    const account = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    invariant(
      Boolean(
        account
          ? (account.githubId && !account.githubConflict) || account.emailVerified
          : user?.subject === owner && user.emailVerified,
      ),
      'AUTH_REQUIRED',
      'Connect a verified identity before sending email invitations.',
    );
  }
  const old = await ctx.db
    .query('projectInvites')
    .withIndex('by_project_and_email', q => q.eq('projectId', projectId).eq('email', person))
    .order('desc')
    .take(1);
  if (isEmail && !(old[0] && invitationStatus(old[0]) === 'pending'))
    await checkOpenEmailInvitations(ctx, projectId);
  const charge = await invitationBudget(ctx, owner, isEmail && invitationEmailEnabled() ? person : undefined);
  const epoch = await invitationEpoch(ctx, projectId);
  // All refusal paths, including all budgets, precede the first write.
  await charge();
  if (old[0] && invitationStatus(old[0]) === 'pending')
    await ctx.db.patch(old[0]._id, { state: 'replaced', endedAt: Date.now() });
  const id = await ctx.db.insert('projectInvites', {
    projectId,
    email: person,
    kind: isEmail ? 'email' : 'handle',
    inviter: owner,
    invitationEpoch: epoch,
    ...(recipient ? { recipient } : {}),
    role,
    operationId,
    state: 'pending',
    expiresAt: Date.now() + invitationLifetime,
  });
  const operation = await ctx.db.insert('projectAccessOperations', {
    projectId,
    owner,
    operationId,
    person,
    role,
  });
  if (isEmail)
    await queueInviteMail(ctx, (await ctx.db.get(operation))!, (await ctx.db.get(id))!, operationId);
  return null;
}
