// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedAgentActions, hostedAgentCapabilitiesSchema } from '../src/hosted-agent-contract';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
/** Discovery is a current-authority read, never a worker wake or an availability promise. */
export const capabilities = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to discover hosted agent capabilities.');
      const project = await accessibleProject(ctx, projectId, user.subject),
        authority = sourceAuthority(project);
      return canonicalPayload(
        hostedAgentCapabilitiesSchema.parse({
          schema: 1,
          projectId,
          actor: user.subject,
          authority,
          actions: authority.mode === 'native-owner' ? ['capabilities'] : hostedAgentActions,
          mainReady: (await channelRow(ctx, projectId)) !== null,
          sourceWorkerConfigured: Boolean(
            process.env.FORGE_SOURCE_WORKER &&
            process.env.FORGE_SOURCE_RUNTIME &&
            process.env.FORGE_SOURCE_KEY_ID,
          ),
          checkCallbackConfigured: Boolean(process.env.FORGE_HOSTED_CHECK_KEY_ID),
          nativeOwnerRequired: false,
          observation: 'finite',
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
