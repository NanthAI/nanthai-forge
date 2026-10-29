// SPDX-License-Identifier: Apache-2.0
import { needsFix } from '../src/culprit-bisect';
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedAgentActions, hostedAgentCapabilitiesSchema } from '../src/hosted-agent-contract';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { requireCutoverVersion } from '../src/cutover-version';
/** Discovery is a current-authority read, never a worker wake or an availability promise. */
export const capabilities = query({
  args: {
    projectId: v.id('hostedProjects'),
    clientVersion: v.optional(v.string()),
    noticeVersion: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, clientVersion, noticeVersion }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to discover hosted agent capabilities.');
      const project = await accessibleProject(ctx, projectId, user.subject),
        authority = sourceAuthority(project);
      if (project.sourceCutover && authority.mode === 'server') requireCutoverVersion(clientVersion);
      return canonicalPayload(
        hostedAgentCapabilitiesSchema.parse({
          ...(noticeVersion === 1 ? { needsFix: needsFix(project) } : {}),
          schema: 1,
          projectId,
          actor: user.subject,
          authority,
          actions: authority.mode === 'native-owner' ? ['capabilities'] : hostedAgentActions,
          mainReady: (await channelRow(ctx, projectId)) !== null,
          sourceWorkerConfigured:
            (process.env.FORGE_SOURCE_PROVIDER ?? 'convex') === 'convex' ||
            (process.env.FORGE_SOURCE_PROVIDER === 'modal' &&
              Boolean(
                process.env.FORGE_SOURCE_WORKER &&
                process.env.FORGE_SOURCE_RUNTIME &&
                process.env.FORGE_SOURCE_KEY_ID,
              )),
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
