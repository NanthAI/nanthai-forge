// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { internalQuery, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { sourceOutput } from './projectSourceStepFields';
import { stateTreeReaders, stateTreePointer } from './projectObjectFields';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import { findObject, objectRow } from './projectObjectFind';
import { hostedStartMain } from './projectHostedChannels';

/** Trees in packs, per project (docs/architecture.md, Storage, "Tree form"). Everything here is internal:
 * an operator sets the flags; the source step reports a refusal with the commit it already makes. */
export async function recordTreeRefusal(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  refused: { state: string; code: string },
) {
  const project = await ctx.db.get(projectId);
  if (!project) return;
  await ctx.db.patch(projectId, {
    stateTrees: {
      ...project.stateTrees,
      refused: { ...refused, at: Date.now(), count: (project.stateTrees?.refused?.count ?? 0) + 1 },
    },
  });
}

/** Turn dual-write and single readers on or off for one project. Dual-write never changes what a
 * reader sees; a reader flag only takes effect for States that have a proven pointer.
 * `clearRefused` acknowledges the alarm. */
export const configure = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    write: v.optional(v.boolean()),
    read: v.optional(v.array(v.union(...stateTreeReaders.map(name => v.literal(name))))),
    clearRefused: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, { projectId, write, read, clearRefused }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removedAt, 'PROJECT_UNAVAILABLE', 'This project is unavailable.');
    const next = {
      ...project.stateTrees,
      ...(write === undefined ? {} : { write }),
      ...(read === undefined ? {} : { read: [...new Set(read)].sort() }),
    };
    if (clearRefused) delete next.refused;
    await ctx.db.patch(projectId, { stateTrees: next });
    return next;
  },
});

/** The flags, the alarm, and main's head with its pointer (one read each). */
export const status = internalQuery({
  args: { projectId: v.id('hostedProjects'), state: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, { projectId, state }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removedAt, 'PROJECT_UNAVAILABLE', 'This project is unavailable.');
    const id = state ?? (await hostedStartMain(ctx, projectId)).head,
      row = id ? await findObject(ctx, projectId, id) : null;
    return {
      stateTrees: project.stateTrees ?? {},
      state: id ?? null,
      size: row?.size ?? null,
      stateTree: row?.stateTree ?? null,
    };
  },
});

/** Record a converted State's proven pointer and the segment it was written to. Write-once. */
export const recordConversion = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    state: v.string(),
    pointer: stateTreePointer,
    segments: v.array(sourceOutput),
  },
  returns: v.boolean(),
  handler: async (ctx, { projectId, state, pointer, segments }) => {
    const project = await ctx.db.get(projectId);
    invariant(project?.stateTrees?.write, 'BAD_ARGUMENT', 'Tree writes are off for this project.');
    const row = await findObject(ctx, projectId, state);
    invariant(row && !row.removed, 'SOURCE_UNAVAILABLE', 'The State is absent.');
    if (row.stateTree) return false;
    await storeSourceOutputs(ctx, projectId, 'state-tree-convert', segments);
    await ctx.db.patch((await objectRow(ctx, row))._id, { stateTree: pointer });
    return true;
  },
});
