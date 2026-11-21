// SPDX-License-Identifier: Apache-2.0
import { journalProject } from './projectJournalStore';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { currentCredential } from './deviceFields';
import { deviceProjectRefusal } from './accessPolicy';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { projectExecution } from './projectExecution';
import { checkedProjectRole, hasWriteRole, projectRole } from './projectRole';
const readProjects = new WeakMap<
  object,
  Map<string, import('./_generated/dataModel').Doc<'hostedProjects'>>
>();
/** A read's result projection reuses the exact project the handler already authorized. No cross-request cache. */
export const authorizedReadProject = (ctx: QueryCtx, id: string) =>
  readProjects.get(ctx.auth ?? ctx.db)?.get(id);
function rememberReadProject(
  ctx: QueryCtx | MutationCtx,
  project: import('./_generated/dataModel').Doc<'hostedProjects'>,
) {
  let projects = readProjects.get(ctx.auth ?? ctx.db);
  if (!projects) readProjects.set(ctx.auth ?? ctx.db, (projects = new Map()));
  projects.set(project._id, project);
}
const readRoles = new WeakMap<object, Map<string, ReturnType<typeof projectRole>>>();
/** Share a current transaction's role resolution with its read projection, never across invocations. */
export function readProjectRole(
  ctx: QueryCtx,
  project: import('./_generated/dataModel').Doc<'hostedProjects'>,
  actor: string,
) {
  if (project.owner === actor) return Promise.resolve('owner' as const);
  const checked = checkedProjectRole(ctx, project, actor);
  if (checked !== undefined) return Promise.resolve(checked);
  const key = ctx.auth ?? ctx.db;
  let roles = readRoles.get(key);
  if (!roles) readRoles.set(key, (roles = new Map()));
  const selection = `${project._id}:${actor}`;
  let role = roles.get(selection);
  if (!role) roles.set(selection, (role = projectRole(ctx, project, actor)));
  return role;
}

const deviceReads = new WeakMap<object, Promise<Doc<'cliCredentials'> | null>>();
/** Reuse the public guard's row; a nested caller checks once in its transaction.
 * Source workers carry trusted job authority and may have no auth surface. */
async function deviceProject(ctx: QueryCtx | MutationCtx, projectId: string, writing = false) {
  let row: Doc<'cliCredentials'> | null | undefined = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null })
    .forgeDevice;
  if (row === undefined) {
    let selected = deviceReads.get(ctx);
    if (!selected) {
      selected = (async () => {
        const user = await ctx.auth?.getUserIdentity();
        if (typeof user?.forgeCredential !== 'string' || typeof user.forgeSignIn !== 'string') return null;
        const found = await ctx.db
          .query('cliCredentials')
          .withIndex('by_credentialId', q => q.eq('credentialId', user.forgeCredential as string))
          .unique();
        invariant(
          currentCredential(found, user.subject, user.forgeSignIn),
          'AUTH_REVOKED',
          'This device sign-in ended. Run nforge login; saved work remains.',
        );
        return found;
      })();
      deviceReads.set(ctx, selected);
    }
    row = await selected;
  }
  const settings = row?.settings;
  invariant(
    !settings || settings.projects.kind === 'all' || settings.projects.projectId === projectId,
    'AUTH_SCOPE_DENIED',
    deviceProjectRefusal,
  );
  invariant(
    !writing || settings?.source !== 'read',
    'AUTH_SCOPE_DENIED',
    'This device is read only. Change its settings in your Forge browser to write; local work is kept.',
  );
}
export async function ownedProject(ctx: QueryCtx | MutationCtx, id: Id<'hostedProjects'>, owner: string) {
  await deviceProject(ctx, id);
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
    rememberReadProject(ctx, project);
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
  await deviceProject(ctx, id, true);
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
): Promise<Doc<'hostedProjects'>>;
export async function accessibleProject(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  forPrune: boolean,
): Promise<Doc<'hostedProjects'> | null>;
export async function accessibleProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  forPrune = false,
) {
  await deviceProject(ctx, projectId);
  const project = await ctx.db.get(projectId);
  let authorized = false;
  try {
    // Only the owner can distinguish permanent deletion from missing access, and
    // this tombstone path never authorizes a read of project or Work data.
    if (
      forPrune &&
      project?.owner === actor &&
      project.removal === 'deleted' &&
      project.purge?.completedAt !== undefined
    )
      return null;
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
    rememberReadProject(ctx, project);
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
  await deviceProject(ctx, id, true);
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
  await deviceProject(ctx, id);
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
  rememberReadProject(ctx, project);
  projectExecution(ctx, id, project.name, project.key);
  return project;
}
