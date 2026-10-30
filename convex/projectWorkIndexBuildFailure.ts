// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { generationDocument } from './projectWorkIndexFields';
import { invariant } from '../src/errors';
export const pendingResumeLimit = 5;
/** Failure-only write. The exact cursor and operation fence concurrent/lost replies. */
export const pending = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    expected: v.string(),
    expectedBatch: v.number(),
    operationId: v.string(),
    pin: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input): Promise<Doc<'projectWorkGenerations'> | null> => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    if (project.work?.backupId !== generation.backupId || project.work.revision !== generation.revision)
      return null;
    if (
      generation.ensureCursor !== input.expected ||
      generation.nextBatch !== input.expectedBatch ||
      generation.status !== 'building'
    )
      return generation;
    const previous = generation.ensureRetry ? JSON.parse(generation.ensureRetry) : undefined;
    if (previous?.cursor === input.expected && previous.operations?.includes(input.operationId))
      return generation;
    const resumes = previous?.cursor === input.expected ? previous.resumes + 1 : 0;
    const failure = {
      operations: [
        ...(previous?.cursor === input.expected ? (previous.operations ?? []) : []),
        input.operationId,
      ],
      cursor: input.expected,
      operationId: input.operationId,
      resumes,
      ...(input.pin ? { pin: input.pin } : {}),
      ...(resumes >= pendingResumeLimit
        ? {
            code: 'WORK_INDEX_READ_FAILED',
            message: `Index read failed after ${pendingResumeLimit} pending resumes at the same cursor${input.pin ? ` (object ${input.pin.sha256})` : ''}.`,
          }
        : {}),
    };
    const update = {
      ensureRetry: JSON.stringify(failure),
      status: resumes >= pendingResumeLimit ? ('failed' as const) : ('building' as const),
    };
    await ctx.db.patch(generation._id, update);
    return { ...generation, ...update };
  },
});
