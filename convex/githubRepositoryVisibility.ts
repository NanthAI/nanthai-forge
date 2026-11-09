// SPDX-License-Identifier: Apache-2.0
// Runner repository visibility: one GitHub read per repository per short expiry,
// kept in one small row. Only private projects read or write it.
import { v } from 'convex/values';
import { convexFetch } from './networkFetch';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import { githubAppRequest } from './githubAppToken';
import { checkCaller } from './projectHostedCheckStore';
import { invariant } from '../src/errors';
import { repositoryVisibility, runnerVisibilityTtlMs } from '../src/runner-visibility';
const row = (ctx: QueryCtx | MutationCtx, repository: string) =>
  ctx.db
    .query('githubRepositoryVisibility')
    .withIndex('by_repository', q => q.eq('repository', repository.toLowerCase()))
    .unique();
/** The cached visibility while fresh, else null (read GitHub again). */
export async function cachedRepositoryVisibility(
  ctx: QueryCtx | MutationCtx,
  repository: string,
  now = Date.now(),
) {
  const cached = await row(ctx, repository);
  return cached && cached.checkedAt <= now && now - cached.checkedAt < runnerVisibilityTtlMs
    ? cached.visibility
    : null;
}
export async function recordRepositoryVisibility(
  ctx: MutationCtx,
  repository: string,
  visibility: string,
  now = Date.now(),
) {
  if (visibility === 'unknown') return;
  const value = { repository: repository.toLowerCase(), visibility, checkedAt: now };
  const existing = await row(ctx, repository);
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert('githubRepositoryVisibility', value);
}
/** One metadata read with a token already minted for this proven repository. */
export async function readRepositoryVisibility(repository: string, token: string, request = convexFetch) {
  return repositoryVisibility(await (await githubAppRequest(`repos/${repository}`, token, request)).json());
}
/** Connect-runner: records the fresh read and returns the project's visibility,
 * to the project owner only (the same boundary as the runner setting itself). */
export const record = internalMutation({
  args: { projectId: v.id('hostedProjects'), repository: v.string(), visibility: v.string() },
  returns: v.union(v.literal('public'), v.literal('private')),
  handler: async (ctx, input) => {
    const { actor, project } = await checkCaller(ctx, input.projectId);
    invariant(project.owner === actor, 'PROJECT_UNAVAILABLE', 'Project check settings belong to its owner.');
    await recordRepositoryVisibility(ctx, input.repository, input.visibility);
    return project.visibility === 'public' ? 'public' : 'private';
  },
});
