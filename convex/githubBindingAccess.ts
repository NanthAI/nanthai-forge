// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
export function operatorBinding(
  projectId: string,
  repo: string,
  bindings = process.env.FORGE_GITHUB_REPO_BINDINGS,
) {
  return (bindings ?? '').split(',').some(item => {
    const [project, name] = item.trim().split('=');
    return project === projectId && name?.toLowerCase() === repo.toLowerCase();
  });
}
export async function bindingInstallation(ctx: QueryCtx | MutationCtx, installationId: number) {
  return ctx.db
    .query('githubBindingInstallations')
    .withIndex('by_installation', q => q.eq('installationId', installationId))
    .unique();
}
/** Settings admit only a proven name or an explicit operator override. Token IO
 * independently checks numeric identity, including after renames/name reuse. */
export async function requireStoredRepositoryBinding(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  repo: string,
) {
  if (operatorBinding(projectId, repo)) return;
  let cursor: string | null = null;
  do {
    const page = await ctx.db
      .query('projectGithubBindings')
      .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('fullName', repo.toLowerCase()))
      .paginate({ cursor, numItems: 100 });
    for (const row of page.page) if (!(await bindingInstallation(ctx, row.installationId))?.removed) return;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  invariant(
    false,
    'GITHUB_REPOSITORY_UNBOUND',
    'Connect this repository to this Forge project with nforge github connect.',
  );
}
