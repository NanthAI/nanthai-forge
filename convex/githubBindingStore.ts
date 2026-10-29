// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { mutation, query, type QueryCtx, type MutationCtx } from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { bindingInstallation } from './githubBindingAccess';
import { invariant } from '../src/errors';
import { report } from './errors';
import { z } from 'zod';
const projectId = v.id('hostedProjects');
async function owner(ctx: QueryCtx | MutationCtx, id: import('./_generated/dataModel').Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to connect GitHub.');
  await activeOwnedProject(ctx, id, user.subject);
  return user.subject;
}
export const start = internalMutation({
  args: {
    projectId,
    operationId: v.string(),
    repository: v.string(),
    installationId: v.number(),
    state: v.string(),
    verifier: v.string(),
    authorizeUrl: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const actor = await owner(ctx, input.projectId);
    invariant(z.uuid().safeParse(input.operationId).success, 'BAD_ARGUMENT', 'Use an operation UUID.');
    const prior = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (prior) {
      invariant(
        prior.actor === actor && prior.repository === input.repository,
        'WORK_OPERATION_CHANGED',
        'Retry the original connection.',
      );
      return JSON.stringify({
        operationId: prior.operationId,
        authorizeUrl: prior.authorizeUrl,
        status: prior.status,
      });
    }
    await ctx.db.insert('githubBindingOperations', { ...input, actor, status: 'waiting' });
    return JSON.stringify({
      operationId: input.operationId,
      authorizeUrl: input.authorizeUrl,
      status: 'waiting',
    });
  },
});
export const consume = internalMutation({
  args: { state: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const op = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_state', q => q.eq('state', input.state))
      .unique();
    invariant(
      op?.status === 'waiting',
      'GITHUB_OAUTH_STATE',
      'Invalid or already used GitHub authorization state.',
    );
    await activeOwnedProject(ctx, op.projectId, op.actor);
    const install = await bindingInstallation(ctx, op.installationId);
    invariant(!install?.removed, 'GITHUB_REPOSITORY_UNBOUND', 'GitHub installation was removed.');
    await ctx.db.patch(op._id, { status: 'processing', revision: install?.revision ?? 0 });
    return JSON.stringify({ ...op, revision: install?.revision ?? 0 });
  },
});
export const complete = internalMutation({
  args: { state: v.string(), repoId: v.number(), fullName: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const op = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_state', q => q.eq('state', input.state))
      .unique();
    invariant(
      op?.status === 'processing',
      'GITHUB_OAUTH_STATE',
      'Invalid or already used GitHub authorization state.',
    );
    await activeOwnedProject(ctx, op.projectId, op.actor);
    const install = await bindingInstallation(ctx, op.installationId);
    invariant(
      !install?.removed && (install?.revision ?? 0) === op.revision,
      'GITHUB_REPOSITORY_UNBOUND',
      'GitHub installation changed during authorization. Connect again.',
    );
    invariant(
      Number.isSafeInteger(input.repoId) &&
        input.repoId > 0 &&
        input.fullName.toLowerCase() === op.repository,
      'GITHUB_REPOSITORY_UNBOUND',
      'Repository proof differs from the connection.',
    );
    const prior = await ctx.db
      .query('projectGithubBindings')
      .withIndex('by_repo', q => q.eq('repoId', input.repoId))
      .unique();
    invariant(
      !prior ||
        prior.projectId === op.projectId ||
        (await bindingInstallation(ctx, prior.installationId))?.removed,
      'GITHUB_REPOSITORY_CLAIMED',
      'This repository is already bound to another Forge project.',
    );
    const binding = {
      projectId: op.projectId,
      repoId: input.repoId,
      fullName: input.fullName.toLowerCase(),
      installationId: op.installationId,
      boundBy: op.actor,
      boundAt: Date.now(),
    };
    if (prior) await ctx.db.replace(prior._id, binding);
    else await ctx.db.insert('projectGithubBindings', binding);
    await ctx.db.patch(op._id, { status: 'completed', repoId: input.repoId, verifier: '' });
    return null;
  },
});
export const fail = internalMutation({
  args: { state: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const op = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_state', q => q.eq('state', input.state))
      .unique();
    if (op?.status === 'processing')
      await ctx.db.patch(op._id, { status: 'failed', code: input.code, verifier: '' });
    return null;
  },
});
export const status = query({
  args: { projectId, operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await owner(ctx, input.projectId);
      const op = await ctx.db
        .query('githubBindingOperations')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      invariant(op, 'GITHUB_OAUTH_STATE', 'Connection operation is unavailable.');
      return JSON.stringify({
        operationId: op.operationId,
        status: op.status,
        repoId: op.repoId ?? null,
        code: op.code ?? null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { projectId, cursor: v.union(v.null(), v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read GitHub bindings.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const page = await ctx.db
        .query('projectGithubBindings')
        .withIndex('by_project_and_installation', q => q.eq('projectId', input.projectId))
        .paginate({ cursor: input.cursor, numItems: 100 });
      const installations = new Map<number, boolean>();
      for (const row of page.page)
        if (!installations.has(row.installationId))
          installations.set(
            row.installationId,
            !(await bindingInstallation(ctx, row.installationId))?.removed,
          );
      return JSON.stringify({
        ...page,
        page: page.page.map(({ _id, _creationTime, ...row }) => ({
          ...row,
          active: installations.get(row.installationId),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const remove = mutation({
  args: { projectId, operationId: v.string(), repoId: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const actor = await owner(ctx, input.projectId);
      invariant(z.uuid().safeParse(input.operationId).success, 'BAD_ARGUMENT', 'Use an operation UUID.');
      const old = await ctx.db
        .query('githubBindingRemovals')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.actor === actor && old.repoId === input.repoId,
          'WORK_OPERATION_CHANGED',
          'Retry the original removal.',
        );
        return null;
      }
      const binding = await ctx.db
        .query('projectGithubBindings')
        .withIndex('by_repo', q => q.eq('repoId', input.repoId))
        .unique();
      invariant(
        !binding || binding.projectId === input.projectId,
        'PROJECT_UNAVAILABLE',
        'Repository belongs to another project.',
      );
      if (binding) {
        const installation = await bindingInstallation(ctx, binding.installationId);
        const revision = {
          installationId: binding.installationId,
          revision: (installation?.revision ?? 0) + 1,
          removed: !!installation?.removed,
        };
        if (installation) await ctx.db.replace(installation._id, revision);
        else await ctx.db.insert('githubBindingInstallations', revision);
        await ctx.db.delete(binding._id);
      }
      await ctx.db.insert('githubBindingRemovals', { ...input, actor });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** Internal token preflight reads only this project's bindings in 100-row pages. */
export const page = internalQuery({
  args: { projectId, installationId: v.number(), cursor: v.union(v.null(), v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Project is unavailable.');
    invariant(
      !(await bindingInstallation(ctx, input.installationId))?.removed,
      'GITHUB_REPOSITORY_UNBOUND',
      'GitHub installation was removed.',
    );
    return JSON.stringify(
      await ctx.db
        .query('projectGithubBindings')
        .withIndex('by_project_and_installation', q =>
          q.eq('projectId', input.projectId).eq('installationId', input.installationId),
        )
        .paginate({ cursor: input.cursor, numItems: 100 }),
    );
  },
});

export const requireId = internalQuery({
  args: { projectId, installationId: v.number(), repoId: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectGithubBindings')
      .withIndex('by_repo', q => q.eq('repoId', input.repoId))
      .unique();
    invariant(
      row?.projectId === input.projectId &&
        row.installationId === input.installationId &&
        !(await bindingInstallation(ctx, input.installationId))?.removed,
      'GITHUB_REPOSITORY_UNBOUND',
      'GitHub repository binding was removed.',
    );
    return null;
  },
});
export const authorize = internalQuery({
  args: { projectId, operationId: v.string(), repository: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const actor = await owner(ctx, input.projectId);
    const prior = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (!prior) return null;
    invariant(
      prior.actor === actor && prior.repository === input.repository,
      'WORK_OPERATION_CHANGED',
      'Retry the original connection.',
    );
    return JSON.stringify({
      operationId: prior.operationId,
      authorizeUrl: prior.authorizeUrl,
      status: prior.status,
    });
  },
});
export const refreshName = internalMutation({
  args: { projectId, repoId: v.number(), installationId: v.number(), fullName: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectGithubBindings')
      .withIndex('by_repo', q => q.eq('repoId', input.repoId))
      .unique();
    invariant(
      row?.projectId === input.projectId &&
        row.installationId === input.installationId &&
        !(await bindingInstallation(ctx, input.installationId))?.removed,
      'GITHUB_REPOSITORY_UNBOUND',
      'GitHub repository binding was removed.',
    );
    if (row.fullName !== input.fullName.toLowerCase())
      await ctx.db.patch(row._id, { fullName: input.fullName.toLowerCase() });
    return null;
  },
});
