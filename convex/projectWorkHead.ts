// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
export const workHead = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectWorkHeads')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
/** Legacy project fields seed the head lazily; only revision-sensitive callers read it. */
export async function workProject(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>) {
  const head = await workHead(ctx, project._id);
  return head && project.work && head.backupId === project.work.backupId
    ? { ...project, work: { ...project.work, revision: head.revision } }
    : project;
}
export async function generationHead(ctx: QueryCtx | MutationCtx, generation: Doc<'projectWorkGenerations'>) {
  const head = await workHead(ctx, generation.projectId);
  return head?.backupId === generation.backupId
    ? { ...generation, revision: head.revision, metadata: head.metadata ?? generation.metadata }
    : generation;
}
export async function setWorkHead(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  backupId: Id<'projectBackups'>,
  revision: number,
  metadata?: string,
) {
  const old = await workHead(ctx, projectId);
  const value = { projectId, backupId, revision, ...(metadata === undefined ? {} : { metadata }) };
  if (old) await ctx.db.replace(old._id, value);
  else await ctx.db.insert('projectWorkHeads', value);
}
