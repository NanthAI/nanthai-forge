// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { githubActionsRunsOnSchema } from '../src/github-actions-runner-label';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { checkHash, checkNumber, checkPin } from '../src/hosted-check';
import { hostedActionsRuntime } from '../src/hosted-actions';
import { report } from './errors';
import { ForgeError, invariant } from '../src/errors';
import { grantRunner } from './githubRunnerGrants';
import { submoduleAllowListSchema } from '../src/submodule-allowlist';
import { actionsPermissions, installationToken, requireInstallationPermissions } from './githubAppToken';
import { readRepositoryVisibility } from './githubRepositoryVisibility';
import { requirePrivateRunner } from '../src/runner-visibility';
const requestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    expected: checkHash.nullable(),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    runsOn: githubActionsRunsOnSchema.default('ubuntu-latest'),
    concurrencyBudget: z.number().safe().int().min(2).optional(),
    /** Owner-only (the configure transaction): accept that check logs are as visible as the repository. */
    publicLogs: z.boolean().optional(),
    /** Owner-only (the configure transaction): private submodule repositories checks may read. */
    submodules: submoduleAllowListSchema.optional(),
  })
  .strict();
/** Reuses the existing owner-only, idempotent configuration transaction. No
 * installation ID or per-project secret is requested or retained; the App
 * resolves the installation per operation. */
export const configure = action({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const parsed = requestSchema.safeParse(JSON.parse(input.request));
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Pass a repository and runsOn as a nonblank label (1–256 characters, no control characters) or 1–100 such labels.',
      );
      const { repository, runsOn, concurrencyBudget, publicLogs, submodules, ...request } = parsed.data;
      // Derive the installation via the App now so a missing install or a pending
      // Actions permission approval fails here, not on the first dispatch. The
      // metadata token proves the binding before any name-scoped token exists. Without an
      // operator or stored binding, the owner's runner grant is proven (or refreshed) instead,
      // and its proof's metadata token (minted only to read the id and role) is used.
      let token: string;
      try {
        token = await installationToken(ctx, input.projectId, repository, { metadata: 'read' });
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === 'GITHUB_REPOSITORY_UNBOUND')) throw error;
        token = await grantRunner(ctx, input.projectId, repository);
      }
      await requireInstallationPermissions(repository, actionsPermissions);
      // A private project's logs must not land in a public runner repository unless
      // its owner (the only caller the record and configure mutations accept) opts in.
      const visibility = await readRepositoryVisibility(repository, token);
      const project: string = await ctx.runMutation(
        makeFunctionReference<'mutation'>('githubRepositoryVisibility:record'),
        { projectId: input.projectId, repository, visibility },
      );
      requirePrivateRunner(project, repository, visibility, publicLogs === true);
      return await ctx.runMutation(
        makeFunctionReference<'mutation', { projectId: typeof input.projectId; request: string }, string>(
          'projectHostedCheckDefinitions:configure',
        ),
        {
          projectId: input.projectId,
          request: JSON.stringify({
            ...request,
            change: {
              kind: 'runner',
              configuration: {
                provider: 'github-actions',
                repository,
                runsOn,
                ...(concurrencyBudget !== undefined ? { concurrencyBudget } : {}),
                ...(publicLogs ? { publicLogs: true } : {}),
                ...(submodules ? { submodules } : {}),
                runtime: hostedActionsRuntime,
                environmentFingerprint: checkPin({
                  runtime: hostedActionsRuntime,
                  runsOn,
                  workflow: 'convex-oidc-v1',
                }),
              },
            },
          }),
        },
      );
    } catch (error) {
      return report(error);
    }
  },
});
