// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './cliServer';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { seedRequestSchema } from '../src/hosted-seed-protocol';
import { invariant } from '../src/errors';

// One indexed seed and one backup, independent of the project's retained history.
async function completed(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const seed = await ctx.db
    .query('projectHostedSeeds')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!seed?.backupId) return null;
  const request = seedRequestSchema.parse(JSON.parse(seed.request));
  if (
    request.format !== 'native' ||
    seed.nextPage !== request.pages ||
    seed.objects !== request.objects ||
    seed.chain !== request.chain
  )
    return null;
  const backup = await ctx.db.get(seed.backupId);
  if (
    !backup ||
    backup.projectId !== projectId ||
    backup.operationId !== seed.operationId ||
    backup.request !== seed.request ||
    backup.digest !== request.root.sha256 ||
    backup.size !== request.root.size ||
    (backup.objectManifest &&
      (backup.objectManifest.digest !== request.root.sha256 ||
        backup.objectManifest.size !== request.root.size)) ||
    backup.validatedClosure !== 1 ||
    backup.historyBackfilling
  )
    return null;
  return { seed, backup };
}
export const inspect = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => JSON.stringify(await completed(ctx, projectId)),
});
export const mark = internalMutation({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups'), request: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const value = await completed(ctx, input.projectId);
    invariant(
      value && value.backup._id === input.backupId && value.seed.request === input.request,
      'WORK_OPERATION_CHANGED',
      'The completed seed differs from the inspected backup.',
    );
    if (value.backup.validatedWorkRecords !== 1)
      await ctx.db.patch(value.backup._id, { validatedWorkRecords: 1 });
    return null;
  },
});
