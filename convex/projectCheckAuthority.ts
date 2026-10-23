// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeProject, accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';

export async function authority(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, write = false) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use project checks.');
  const project = await (write ? activeProject : accessibleProject)(ctx, projectId, user.subject);
  return { actor: user.subject, project };
}
export async function ownedRunner(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  runnerId: string,
) {
  const { actor } = await authority(ctx, projectId, true);
  const runner = await selectedRunner(ctx, projectId, runnerId);
  invariant(
    runner?.actor === actor,
    'PROJECT_UNAVAILABLE',
    'Only the runner owner can queue or execute checks on this computer.',
  );
  return runner;
}
const selectedRunner = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, runnerId: string) =>
  ctx.db
    .query('projectCheckRunners')
    .withIndex('by_project_and_runner', q => q.eq('projectId', projectId).eq('runnerId', runnerId))
    .unique();
export const selectedRequest = (
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) =>
  ctx.db
    .query('projectCheckRequests')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();

export async function editableRequest(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const { actor, project } = await authority(ctx, projectId, true);
  const item = await selectedRequest(ctx, projectId, operationId);
  invariant(item, 'NOT_FOUND', 'Select an existing project check request.');
  const runner = await selectedRunner(ctx, projectId, item.runnerId);
  invariant(
    actor === item.actor || actor === runner?.actor || actor === project.owner,
    'PROJECT_UNAVAILABLE',
    'Only the requester, runner owner or project owner can change this check request.',
  );
  return item;
}
