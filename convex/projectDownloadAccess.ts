// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx, MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';
/** A public mirror is metadata, never history or object IO. Private project names stay private. */
export async function downloadSignInMessage(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  project: Doc<'hostedProjects'> | null,
) {
  const message = 'Sign in to download or clone from Forge: nforge login.';
  if (!project || project.removal || project.visibility !== 'public') return message;
  const [mirror] = await ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .take(1);
  return mirror && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(mirror.repository)
    ? `${message} For anonymous cloning, use the GitHub mirror: https://github.com/${mirror.repository}.git`
    : message;
}
/** Download-only boundaries; public in-page viewing keeps its existing reader. */
export async function downloadProject(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  if (!user)
    invariant(
      false,
      'PROJECT_UNAVAILABLE',
      await downloadSignInMessage(ctx, projectId, await ctx.db.get(projectId)),
    );
  return accessibleProject(ctx, projectId, user.subject);
}
