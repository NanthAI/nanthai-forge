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
/** Numeric identity an Actions token for this project's runner repository is minted for. */
export type RunnerScope = { repoId: number; installationId: number };
/** The project owner's runner grant for this repository name, if active. Two or three
 * indexed reads; no GitHub IO. A project moved to another owner loses its old owner's grants. */
export async function runnerGrant(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  repo: string,
) {
  const project = await ctx.db.get(projectId);
  if (!project || project.removal) return null;
  const grant = await ctx.db
    .query('githubRunnerGrants')
    .withIndex('by_owner_and_name', q => q.eq('owner', project.owner).eq('fullName', repo.toLowerCase()))
    .unique();
  if (!grant || (await bindingInstallation(ctx, grant.installationId))?.removed) return null;
  return grant;
}
/** Read inside the mutation that already precedes each Actions token mint (reserve, cancel,
 * lookup, confirm, submodule access), so a grant-only runner adds no Convex call per check.
 * Null keeps the operator/stored-binding path unchanged. */
export async function runnerTokenScope(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  repo: string,
): Promise<RunnerScope | null> {
  if (operatorBinding(projectId, repo)) return null;
  const grant = await runnerGrant(ctx, projectId, repo);
  return grant ? { repoId: grant.repoId, installationId: grant.installationId } : null;
}
/** Settings admit only a proven name or an explicit operator override. Token IO
 * independently checks numeric identity, including after renames/name reuse.
 * `runner` also admits the owner's runner grant (runner configuration only, never the mirror). */
export async function requireStoredRepositoryBinding(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  repo: string,
  options: { runner?: boolean } = {},
) {
  if (operatorBinding(projectId, repo)) return;
  if (options.runner && (await runnerGrant(ctx, projectId, repo))) return;
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
