// SPDX-License-Identifier: Apache-2.0
// Runner grants (Issue 77fa4412): one owner-proven permission for that owner's projects
// to run hosted checks on a GitHub repository. configure-runner writes it with no
// browser step and no operator setting: the GitHub App reads the repository's numeric id
// and the role of the GitHub account the identity provider verified for this Forge
// account. Actions use only; the mirror still needs a per-project binding.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexFetch } from './networkFetch';
import { activeOwnedProject } from './projectAuthority';
import { bindingInstallation } from './githubBindingAccess';
import { appInstallation, metadataProbeToken } from './githubAppToken';
import { linkedGithubAccounts } from './githubBindingOAuth';
import { githubRequest } from '../src/hosted-github-api';
import { invariant } from '../src/errors';

/** Roles that may administer Actions on a repository, as in `nforge github connect`. */
const runnerRoles = new Set(['admin', 'maintain']);

type Proof = { repoId: number; fullName: string; installationId: number; githubAccount: string };

/** GitHub calls: one installation lookup, one metadata-read token mint, one repository read,
 * then per linked account (at most 10, usually 1) a user lookup by numeric id and one role
 * read, stopping at the first admin or maintainer. Tokens stay on this stack. */
export async function proveRunnerAccess(
  repo: string,
  githubAccounts: readonly string[],
  request: typeof fetch = convexFetch,
  now = Date.now(),
): Promise<Proof & { token: string }> {
  const { api, installation } = await appInstallation(repo, request, now);
  const token = await metadataProbeToken(api, installation.id, repo);
  const read = githubRequest(token, request);
  const found = await read<{ id?: unknown; full_name?: unknown }>(`/repos/${repo}`);
  invariant(
    typeof found.id === 'number' &&
      Number.isSafeInteger(found.id) &&
      found.id > 0 &&
      typeof found.full_name === 'string' &&
      found.full_name.toLowerCase() === repo.toLowerCase(),
    'GITHUB_REPOSITORY_UNBOUND',
    'GitHub returned another repository for this name.',
  );
  for (const account of githubAccounts) {
    try {
      const user = await read<{ id?: unknown; login?: unknown }>(`/user/${account}`);
      if (String(user.id) !== account || typeof user.login !== 'string' || !/^[\w-]{1,39}$/.test(user.login))
        continue;
      const role = await read<{ role_name?: unknown; permission?: unknown; user?: { id?: unknown } }>(
        `/repos/${repo}/collaborators/${user.login}/permission`,
      );
      if (
        String(role.user?.id) === account &&
        (runnerRoles.has(String(role.role_name)) || role.permission === 'admin')
      )
        return {
          repoId: found.id,
          fullName: found.full_name,
          installationId: installation.id,
          githubAccount: account,
          token,
        };
    } catch {
      // An unreadable account is not proof; try the next linked account.
    }
  }
  invariant(
    false,
    'GITHUB_REPOSITORY_PERMISSION',
    `The GitHub account linked to this Forge account needs admin or maintain on ${repo} to run checks there.`,
  );
}

/** Proves and records the caller's grant, returning the proof's metadata-read token for
 * this one repository (configure reads its visibility with it). Called by configure-runner
 * only after the operator and stored-binding paths refused; the configure transaction
 * rechecks the grant. */
export async function grantRunner(ctx: ActionCtx, projectId: Id<'hostedProjects'>, repo: string) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to configure a runner.');
  const { token, ...proof } = await proveRunnerAccess(repo, await linkedGithubAccounts(user.subject));
  await ctx.runMutation(makeFunctionReference<'mutation'>('githubRunnerGrants:put'), { projectId, ...proof });
  return token;
}

/** Owner-only upsert keyed by (owner, numeric id); a renamed or recreated repository
 * replaces the old row for the same owner. At most two indexed reads and one write. */
export const put = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    repoId: v.number(),
    fullName: v.string(),
    installationId: v.number(),
    githubAccount: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to configure a runner.');
    const owner = user.subject;
    await activeOwnedProject(ctx, input.projectId, owner);
    invariant(
      !(await bindingInstallation(ctx, input.installationId))?.removed,
      'GITHUB_REPOSITORY_UNBOUND',
      'GitHub installation was removed.',
    );
    const fullName = input.fullName.toLowerCase();
    const row = {
      owner,
      repoId: input.repoId,
      fullName,
      installationId: input.installationId,
      githubAccount: input.githubAccount,
      grantedAt: Date.now(),
    };
    const byId = await ctx.db
      .query('githubRunnerGrants')
      .withIndex('by_owner_and_repo', q => q.eq('owner', owner).eq('repoId', input.repoId))
      .unique();
    const byName = await ctx.db
      .query('githubRunnerGrants')
      .withIndex('by_owner_and_name', q => q.eq('owner', owner).eq('fullName', fullName))
      .unique();
    if (byName && byName._id !== byId?._id) await ctx.db.delete(byName._id);
    if (byId) await ctx.db.replace(byId._id, row);
    else await ctx.db.insert('githubRunnerGrants', row);
    return null;
  },
});
