// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';

const counter = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectAccessOperations')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', undefined))
    .unique();

/** Creation and removal serialize on one small project-scoped record, without clock ties. */
export async function invitationEpoch(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  return (await counter(ctx, projectId))?.invitationEpoch ?? 0;
}
export async function endInvitationEpoch(ctx: MutationCtx, projectId: Id<'hostedProjects'>, owner: string) {
  const row = await counter(ctx, projectId),
    next = (row?.invitationEpoch ?? 0) + 1;
  // Requests require string operation ids. An omitted key cannot collide with any request.
  if (row) await ctx.db.patch(row._id, { invitationEpoch: next });
  else
    await ctx.db.insert('projectAccessOperations', {
      projectId,
      owner,
      person: 'invitation-generation',
      invitationEpoch: next,
    });
  return next;
}

export type InvitationRevocations = Map<string, Promise<number>>;
/** The recipient supplies the account. Never resolve a pending address for its inviter. */
export async function invitationWasRevoked(
  ctx: QueryCtx | MutationCtx,
  row: Pick<Doc<'projectInvites'>, 'projectId' | 'invitationEpoch'>,
  recipient: string,
  cache?: InvitationRevocations,
) {
  const projectId = row.projectId;
  if (!projectId) return false;
  const key = JSON.stringify([projectId, recipient]);
  let pending = cache?.get(key);
  if (!pending) {
    pending = ctx.db
      .query('projectActorNames')
      .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', recipient))
      .unique()
      .then(value => value?.invitationsEndedBeforeEpoch ?? 0);
    cache?.set(key, pending);
  }
  return (row.invitationEpoch ?? 0) < (await pending);
}

/** Legacy rows prove their inviter through the retained original operation, not today's owner. */
export async function invitationInviter(ctx: QueryCtx | MutationCtx, row: Doc<'projectInvites'>) {
  if (row.inviter !== undefined) return row.inviter;
  const projectId = row.projectId;
  if (!projectId || !row.operationId) return null;
  return (
    (
      await ctx.db
        .query('projectAccessOperations')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', row.operationId!),
        )
        .unique()
    )?.owner ?? null
  );
}
