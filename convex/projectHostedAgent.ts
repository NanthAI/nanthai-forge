// SPDX-License-Identifier: Apache-2.0
import { needsFix } from '../src/culprit-bisect';
import { githubMirrorStatus } from './projectGithubMirrorStatus';
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { sourceAuthority } from '../src/hosted-source-authority';
import {
  hostedAgentActions,
  hostedAgentCapabilitiesSchema,
  hostedAgentPlanningActions,
} from '../src/hosted-agent-contract';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { requireCutoverVersion } from '../src/cutover-version';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import { advertisedFeatures, MAX_CONTRACT_FEATURES } from '../src/hosted-contract-features';
/** Discovery is a current-authority read, never a worker wake or an availability promise. */
export const capabilities = query({
  args: {
    projectId: v.id('hostedProjects'),
    clientVersion: v.optional(v.string()),
    noticeVersion: v.optional(v.literal(1)),
    resolveVersion: v.optional(v.literal(1)),
    overlapVersion: v.optional(v.literal(1)),
    overlapEvidenceVersion: v.optional(v.literal(1)),
    mirrorVersion: v.optional(v.literal(1)),
    metricReceiptVersion: v.optional(v.literal(1)),
    planningVersion: v.optional(v.literal(1)),
    defaultsVersion: v.optional(v.literal(1)),
    landingMessageVersion: v.optional(v.literal(1)),
    openLanesVersion: v.optional(v.literal(1)),
    presenceVersion: v.optional(v.literal(1)),
    /** Contract features the client may rely on; the reply names the ones this code implements. */
    features: v.optional(v.array(v.string())),
    boardVersion: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (
    ctx,
    {
      projectId,
      clientVersion,
      noticeVersion,
      resolveVersion,
      overlapVersion,
      overlapEvidenceVersion,
      mirrorVersion,
      metricReceiptVersion,
      planningVersion,
      defaultsVersion,
      landingMessageVersion,
      openLanesVersion,
      presenceVersion,
      features,
      boardVersion,
    },
  ) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to discover hosted agent capabilities.');
      const project = await accessibleProject(ctx, projectId, user.subject),
        authority = sourceAuthority(project);
      if (project.sourceCutover && authority.mode === 'server') requireCutoverVersion(clientVersion);
      invariant(
        !features || features.length <= MAX_CONTRACT_FEATURES,
        'BAD_ARGUMENT',
        `Name at most ${MAX_CONTRACT_FEATURES} contract features.`,
      );
      return canonicalPayload(
        hostedAgentCapabilitiesSchema.parse({
          ...(landingMessageVersion === 1 ? { landingMessageVersion: 1 } : {}),
          ...(features ? { features: advertisedFeatures(features) } : {}),
          ...(openLanesVersion === 1 ? { openLanesVersion: 1 } : {}),
          ...(presenceVersion === 1 ? { presenceVersion: 1 } : {}),
          ...(boardVersion === 1 ? { boardVersion: 1 } : {}),
          ...(overlapVersion === 1 ? { overlapVersion: 1 } : {}),
          ...(overlapEvidenceVersion === 1 ? { overlapEvidenceVersion: 1 } : {}),
          ...(metricReceiptVersion === 1 ? { metricReceiptVersion: 1 } : {}),
          ...(defaultsVersion === 1
            ? { agentDefaults: effectiveAgentDefaults(effectivePolicy(project).agentDefaults) }
            : {}),
          ...(noticeVersion === 1 ? { needsFix: needsFix(project) } : {}),
          ...(mirrorVersion === 1 ? { githubMirror: await githubMirrorStatus(ctx, project) } : {}),
          schema: 1,
          projectId,
          actor: user.subject,
          authority,
          actions:
            authority.mode === 'native-owner'
              ? ['capabilities']
              : hostedAgentActions.filter(
                  action =>
                    (action !== 'resolve' || resolveVersion === 1) &&
                    (!(hostedAgentPlanningActions as readonly string[]).includes(action) ||
                      planningVersion === 1),
                ),
          mainReady: (await channelRow(ctx, projectId)) !== null,
          sourceWorkerConfigured: (process.env.FORGE_SOURCE_PROVIDER ?? 'convex') === 'convex',
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
