// SPDX-License-Identifier: Apache-2.0
import { journalProject } from './projectJournalStore';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { projectExecution } from './projectExecution';
import { hasWriteRole, projectRole } from './projectRole';
export async function ownedProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, owner: string) {
  const project = await ctx.db.get(id);
  let authorized = false;
  try {
    invariant(
      // A deleted project is hidden from everyone, its owner included, until restored.
      project?.owner === owner && !project.removal,
      'PROJECT_UNAVAILABLE',
      'This Forge project is unavailable with the current account.',
    );
    authorized = true;
    journalProject(ctx, project);
    return project;
  } finally {
    projectExecution(ctx, id, authorized ? project?.name : undefined, authorized ? project?.key : undefined);
  }
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
  let authorized = false;
  try {
    invariant(
      project && !project.removal,
      'PROJECT_UNAVAILABLE',
      'This Forge project is unavailable with the current account.',
    );
    // A private project without a role answers exactly like a missing one (not found).
    if (project.owner !== actor && project.visibility !== 'public')
      invariant(
        await projectRole(ctx, project, actor),
        'PROJECT_UNAVAILABLE',
        'This Forge project is unavailable with the current account.',
      );
    authorized = true;
    journalProject(ctx, project);
    return project;
  } finally {
    projectExecution(
      ctx,
      projectId,
      authorized ? project?.name : undefined,
      authorized ? project?.key : undefined,
    );
  }
}
export async function activeProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, actor: string) {
  const project = await accessibleProject(ctx, id, actor);
  invariant(
    await hasWriteRole(ctx, project, actor),
    'PROJECT_UNAVAILABLE',
    'Contributor access is required to change project Work.',
  );
  invariant(
    !project.removal,
    'PROJECT_UNAVAILABLE',
    'Restore this project before changing its source or Work.',
  );
  return project;
}

/** Full Work archives belong to project members, independently of public source visibility. */
export async function memberProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, actor: string) {
  const project = await ctx.db.get(id);
  invariant(
    project && !project.removal,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  invariant(
    await hasWriteRole(ctx, project, actor),
    'PROJECT_UNAVAILABLE',
    'Project membership is required to read full Work archives.',
  );
  journalProject(ctx, project);
  projectExecution(ctx, id, project.name, project.key);
  return project;
}
