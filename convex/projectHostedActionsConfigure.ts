// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { checkHash, checkNumber, checkPin } from '../src/hosted-check';
import { hostedActionsRuntime } from '../src/hosted-actions';
import { report } from './errors';
import { actionsPermissions, requireInstallationPermissions } from './githubAppToken';
const requestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    expected: checkHash.nullable(),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
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
      const { repository, ...request } = requestSchema.parse(JSON.parse(input.request));
      // Derive the installation via the App now so a missing install or a pending
      // Actions permission approval fails here, not on the first dispatch.
      await requireInstallationPermissions(repository, actionsPermissions);
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
                runsOn: 'ubuntu-latest',
                runtime: hostedActionsRuntime,
                environmentFingerprint: checkPin({
                  runtime: hostedActionsRuntime,
                  runsOn: 'ubuntu-latest',
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
