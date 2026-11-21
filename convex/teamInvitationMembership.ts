// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { memberHandle } from './teamHandles';
import { invitationEmailHash } from './projectInvitationPolicy';
import { invariant } from '../src/errors';

export const teamInvitationOperation = (
  ctx: QueryCtx | MutationCtx,
  teamId: Id<'teams'>,
  operationId: string,
) =>
  ctx.db
    .query('projectInvites')
    .withIndex('by_teamId_and_operationId', q => q.eq('teamId', teamId).eq('operationId', operationId))
    .unique();

export function assertTeamEmailOperation(operationId?: string) {
  invariant(
    operationId === undefined || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId),
    'BAD_ARGUMENT',
    'Retain the team invitation operation id.',
  );
}

export const teamEmailOperationKey = (email: string, operationId?: string) =>
  operationId ?? 'team-email:' + invitationEmailHash(email.trim().toLowerCase());

/** Direct grants keep a retry receipt without retaining the address or entering the inbox. */
export function teamEmailReplay(row: Doc<'projectInvites'>, email: string) {
  const normalized = email.trim().toLowerCase();
  const direct = row.email === '' && row.state === 'accepted';
  invariant(
    direct ? row.target === invitationEmailHash(normalized) : row.email === normalized,
    'WORK_OPERATION_CHANGED',
    'Retry the original team email request.',
  );
  return direct ? ('direct' as const) : ('pending' as const);
}

export async function recordDirectTeamEmail(
  ctx: MutationCtx,
  teamId: Id<'teams'>,
  email: string,
  operationId: string,
) {
  await ctx.db.insert('projectInvites', {
    teamId,
    email: '',
    target: invitationEmailHash(email.trim().toLowerCase()),
    state: 'accepted',
    operationId,
  });
}

const revocationKey = (member: string) => 'team-revocation:' + member;

export async function teamInvitationWasRevoked(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'projectInvites'> & { teamId: Id<'teams'> },
  member: string,
) {
  if (row.invitationEpoch === undefined) return false;
  const revoked = await teamInvitationOperation(ctx, row.teamId, revocationKey(member));
  return row.invitationEpoch < (revoked?.invitationEpoch ?? 0);
}

export async function endTeamInvitations(ctx: MutationCtx, team: Doc<'teams'>, member: string) {
  if (team.invitationEpoch === undefined) return;
  const operationId = revocationKey(member);
  const generation = team.invitationEpoch + 1;
  const old = await teamInvitationOperation(ctx, team._id, operationId);
  await ctx.db.patch(team._id, { invitationEpoch: generation });
  if (old) await ctx.db.patch(old._id, { invitationEpoch: generation });
  else
    await ctx.db.insert('projectInvites', {
      teamId: team._id,
      email: '',
      state: 'cancelled',
      operationId,
      invitationEpoch: generation,
    });
}

export async function addTeamMembership(ctx: MutationCtx, teamId: Id<'teams'>, member: string) {
  const old = await ctx.db
    .query('teamMembers')
    .withIndex('by_teamId_and_member', q => q.eq('teamId', teamId).eq('member', member))
    .unique();
  if (!old) await ctx.db.insert('teamMembers', { teamId, member, handle: await memberHandle(ctx, member) });
}
