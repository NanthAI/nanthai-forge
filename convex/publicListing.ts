// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { isPublicProject } from './publicVisibility';

/** A project's discovery row (stars, public settings), or null before anyone needed one. One indexed read. */
export const publicRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectPublic')
    .withIndex('by_projectId', q => q.eq('projectId', projectId))
    .unique();

/** The project's listing row, created on first need. `listed` follows the project's visibility. */
export async function ensurePublicRow(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const listed = isPublicProject(project);
  const row = await publicRow(ctx, project._id);
  if (row) {
    if (row.listed !== listed) await ctx.db.patch(row._id, { listed });
    return { ...row, listed };
  }
  const id = await ctx.db.insert('projectPublic', {
    projectId: project._id,
    owner: project.owner,
    listed,
    stars: 0,
  });
  return (await ctx.db.get(id))!;
}
