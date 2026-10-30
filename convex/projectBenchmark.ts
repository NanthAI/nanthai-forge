// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { projectExecution } from './projectExecution';

const target = { projectId: v.id('hostedProjects'), name: v.string() };
async function selected(ctx: QueryCtx, input: { projectId: Id<'hostedProjects'>; name: string }) {
  const project = await ctx.db.get(input.projectId);
  invariant(
    project && (project.name === input.name || (project.removal === 'deleted' && project.name === '')),
    'BENCHMARK_PROJECT_CHANGED',
    'Retain the named test project.',
  );
  projectExecution(ctx, project._id, project.removal === 'deleted' ? undefined : project.name);
  return project;
}
export const project = internalQuery({
  args: target,
  returns: v.object({
    revision: v.number(),
    removal: v.string(),
    purgeBlocked: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    const row = await selected(ctx, input);
    return {
      revision: row.revision,
      removal: row.removal ?? 'active',
      purgeBlocked: row.purgeBlocked ?? null,
    };
  },
});
/** Explicit benchmark cleanup, never scheduled or called by product traffic.
 * Ten rows also bound identity reads when legacy jobs contain near-1 MiB cursors.
 * System rows have no project index: scan one creation-time page, then resolve
 * only import/index identities. Never cancel project deletion or foreign work.
 * cancel(inProgress) allows the action to finish but cancels its descendants. */
export const cancelScheduled = internalMutation({
  args: {
    ...target,
    operationId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ scanned: v.number(), canceled: v.number(), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, input) => {
    const project = await selected(ctx, input);
    invariant(input.operationId.trim(), 'BAD_ARGUMENT', 'Retain the benchmark operation.');
    const page = await ctx.db.system
      .query('_scheduled_functions')
      .withIndex('by_creation_time', q => q.gte('_creationTime', project._creationTime))
      .paginate({ cursor: input.cursor, numItems: 10, maximumBytesRead: 512 * 1024 });
    let canceled = 0;
    for (const task of page.page) {
      if (!['pending', 'inProgress'].includes(task.state.kind)) continue;
      const name = task.name.replace('.js:', ':');
      const args = task.args[0] as
        | {
            projectId?: Id<'hostedProjects'>;
            id?: Id<'projectGithubImports'>;
            generationId?: Id<'projectWorkGenerations'>;
          }
        | undefined;
      if (!args) continue;
      let projectId;
      if (name === 'projectGithubImportWorker:run' && args.id)
        projectId = (await ctx.db.get(args.id))?.projectId;
      else if (
        [
          'projectWorkIndexStore:retire',
          'projectWorkIndexStore:retirePayload',
          'projectWorkIndexStore:sweep',
        ].includes(name)
      )
        projectId =
          args.projectId ??
          (args.generationId ? (await ctx.db.get(args.generationId))?.projectId : undefined);
      if (projectId !== input.projectId) continue;
      await ctx.scheduler.cancel(task._id);
      canceled++;
    }
    return { scanned: page.page.length, canceled, isDone: page.isDone, cursor: page.continueCursor };
  },
});
