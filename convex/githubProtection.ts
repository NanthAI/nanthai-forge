// SPDX-License-Identifier: Apache-2.0
// Two-way sync protection (owner decision A1, Issue 0b481f5f): Forge never writes a ruleset
// and the App holds no Administration. This reads what GitHub enforces on main (Metadata read)
// and prints the ruleset a repository admin imports once.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { internalQuery } from './server';
import { accessibleProject } from './projectAuthority';
import { assertRepositoryName, installationTokenMinter } from './githubAppToken';
import { githubRequest } from '../src/hosted-github-api';
import { forgeRuleset, protectionAdvice, protectionFindings } from '../src/github-pull-check';
import { invariant } from '../src/errors';
import { report } from './errors';

/** The project's binding for this repository: proof it is connected and the connecting role. */
export const binding = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), repository: v.string() },
  returns: v.union(v.null(), v.object({ role: v.union(v.null(), v.string()) })),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectGithubBindings')
      .withIndex('by_project_and_name', q =>
        q.eq('projectId', input.projectId).eq('fullName', input.repository),
      )
      .unique();
    return row ? { role: row.role ?? null } : null;
  },
});
/** Rulesets read per check; a repository rarely has more on main. */
const rulesetLimit = 5;
/** One action: 1 binding read, the App's installation lookup and token mint (as every App
 * call), 1 rules read and at most 5 ruleset reads. Never writes to GitHub or Convex. */
export const check = action({
  args: { projectId: v.id('hostedProjects'), repository: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read GitHub protection.');
      const repository = input.repository.toLowerCase();
      assertRepositoryName(repository);
      const bound: { role: string | null } | null = await ctx.runQuery(
        makeFunctionReference<'query'>('githubProtection:binding'),
        { projectId: input.projectId, actor: user.subject, repository },
      );
      const appId = Number(process.env.GITHUB_APP_ID);
      invariant(Number.isSafeInteger(appId) && appId > 0, 'GITHUB_APP_CONFIG', 'Configure GITHUB_APP_ID.');
      const mint = await installationTokenMinter(ctx, input.projectId, repository);
      const api = githubRequest(await mint({ metadata: 'read' }));
      const rules = await api<{ type?: unknown; parameters?: unknown; ruleset_id?: unknown }[]>(
        `/repos/${repository}/rules/branches/main`,
      );
      invariant(Array.isArray(rules), 'GITHUB_RESPONSE', 'GitHub returned unexpected branch rules.');
      const ids = [...new Set(rules.map(rule => rule.ruleset_id).filter(Number.isSafeInteger))].slice(
        0,
        rulesetLimit,
      );
      const rulesets = [];
      for (const id of ids)
        rulesets.push(
          await api<{ bypass_actors?: { actor_id?: unknown; actor_type?: unknown }[] }>(
            `/repos/${repository}/rulesets/${id}`,
          ),
        );
      const findings = protectionFindings(rules, appId, rulesets);
      const role = bound?.role === 'admin' || bound?.role === 'maintain' ? bound.role : null;
      return JSON.stringify({
        repository,
        appId,
        role,
        ...findings,
        advice: protectionAdvice(repository, findings, role),
        ruleset: findings.protected ? null : forgeRuleset(appId),
      });
    } catch (error) {
      return report(error);
    }
  },
});
