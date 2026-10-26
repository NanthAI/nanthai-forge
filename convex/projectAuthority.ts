// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
export async function ownedProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, owner: string) {
  const project = await ctx.db.get(id);
  invariant(
    project?.owner === owner && !['deleting', 'deleted'].includes(project.removal ?? ''),
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  return project;
}
export async function activeOwnedProject(
  ctx: QueryCtx | MutationCtx,
  id: Id<'hostedProjects'>,
  owner: string,
) {
  const project = await ownedProject(ctx, id, owner);
  invariant(
    !project.removal,
    'PROJECT_UNAVAILABLE',
    'Restore this project before changing its source or Work.',
  );
  return project;
}
export async function accessibleProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
) {
  const project = await ctx.db.get(projectId);
  invariant(
    project && !['deleting', 'deleted'].includes(project.removal ?? ''),
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  invariant(
    project.owner === actor || !project.removal,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  if (project.owner !== actor && project.visibility !== 'public') {
    const grant = await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
      .unique();
    const reader = grant
      ? null
      : await ctx.db
          .query('projectReaders')
          .withIndex('by_project_and_reader', q => q.eq('projectId', projectId).eq('reader', actor))
          .unique();
    invariant(
      grant || reader,
      'PROJECT_UNAVAILABLE',
      'This Forge project is unavailable with the current account.',
    );
  }
  return project;
}
export async function activeProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, actor: string) {
  const project = await accessibleProject(ctx, id, actor);
  if (project.owner !== actor) {
    const contributor = await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q => q.eq('projectId', id).eq('contributor', actor))
      .unique();
    invariant(contributor, 'PROJECT_UNAVAILABLE', 'Contributor access is required to change project Work.');
  }
  invariant(
    !project.removal,
    'PROJECT_UNAVAILABLE',
    'Restore this project before changing its source or Work.',
  );
  return project;
}
