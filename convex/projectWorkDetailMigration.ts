// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
const pin = v.object({ sha256: v.string(), size: v.number() });
const scope = { projectId: v.id('hostedProjects'), owner: v.string(), operationId: v.string() };
const row = async (ctx: MutationCtx, input: { projectId: Id<'hostedProjects'>; operationId: string }) =>
  ctx.db
    .query('projectWorkDetailMigrations')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', input.projectId).eq('operationId', input.operationId),
    )
    .unique();
async function current(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; owner: string },
  saved: Doc<'projectWorkDetailMigrations'>,
) {
  const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
  invariant(
    project.work?.backupId === saved.backupId &&
      project.work.revision === saved.revision &&
      JSON.stringify(sourceAuthority(project)) === saved.authority,
    'WORK_STALE',
    'Work or source authority changed during detail migration. Staged objects remain preserved.',
  );
  return project;
}
export const begin = internalMutation({
  args: scope,
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    invariant(project.work, 'PROJECT_WORK_MISSING', 'Initialize hosted Work before migrating its details.');
    const previous = await row(ctx, input);
    if (previous) {
      if (!previous.root) await current(ctx, input, previous);
      return JSON.stringify(previous);
    }
    const id = await ctx.db.insert('projectWorkDetailMigrations', {
      projectId: input.projectId,
      operationId: input.operationId,
      backupId: project.work.backupId,
      revision: project.work.revision,
      authority: JSON.stringify(sourceAuthority(project)),
      collection: 0,
      offset: 0,
      pages: null,
    });
    return JSON.stringify(await ctx.db.get(id));
  },
});
export const advance = internalMutation({
  args: {
    ...scope,
    collection: v.number(),
    offset: v.number(),
    pages: pin,
    nextCollection: v.number(),
    nextOffset: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const saved = await row(ctx, input);
    invariant(saved, 'WORK_STALE', 'Resume the original detail migration.');
    await current(ctx, input, saved);
    if (
      saved.collection === input.nextCollection &&
      saved.offset === input.nextOffset &&
      saved.pages?.sha256 === input.pages.sha256
    )
      return null;
    invariant(
      !saved.root && saved.collection === input.collection && saved.offset === input.offset,
      'WORK_STALE',
      'The detail migration page already advanced; resume its saved cursor.',
    );
    await ctx.db.patch(saved._id, {
      collection: input.nextCollection,
      offset: input.nextOffset,
      pages: input.pages,
    });
    return null;
  },
});
export const publish = internalMutation({
  args: { ...scope, root: pin },
  returns: v.null(),
  handler: async (ctx, input) => {
    const saved = await row(ctx, input);
    invariant(saved, 'WORK_STALE', 'Resume the original detail migration.');
    if (saved.root) {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      invariant(
        saved.root.sha256 === input.root.sha256 && saved.root.size === input.root.size,
        'WORK_OPERATION_CHANGED',
        'The detail migration retains its original root.',
      );
      return null;
    }
    const project = await current(ctx, input, saved);
    invariant(
      saved.collection === 2,
      'INVALID_WORK_STORE',
      'Complete both detail collections before publication.',
    );
    await ctx.db.patch(saved._id, { root: input.root });
    await ctx.db.patch(project._id, {
      work: {
        ...project.work!,
        generationId: undefined,
        recordDetails: {
          operationId: input.operationId,
          backupId: saved.backupId,
          revision: saved.revision,
          root: input.root,
        },
      },
    });
    return null;
  },
});
