// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation } from './_generated/server';
import {
  claimLandingQueue,
  advanceLandingQueue,
  recoverLandingQueue,
  type LandingClaim,
} from './projectHostedLandingControl';
import { wakeLandingCheck } from './projectHostedLandingWake';
import { canonicalPayload } from '../src/hosted-source-operation';
const channel = { projectId: v.id('hostedProjects'), channel: v.literal('main') };
const claimFields = {
  ...channel,
  owner: v.string(),
  token: v.number(),
  submissionId: v.string(),
  attemptId: v.string(),
};
export const claim = internalMutation({
  args: { ...channel, wakeId: v.string() },
  returns: v.union(v.object(claimFields), v.null()),
  handler: (ctx, input) => claimLandingQueue(ctx, input),
});
export const advance = internalMutation({
  args: claimFields,
  returns: v.string(),
  handler: async (ctx, input) => canonicalPayload(await advanceLandingQueue(ctx, input)),
});
export const recover = internalMutation({
  args: channel,
  returns: v.boolean(),
  handler: (ctx, input) => recoverLandingQueue(ctx, input),
});
export const checkWake = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), wakeId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await wakeLandingCheck(ctx, input);
    return null;
  },
});
/** Two short transactions, no provider wait, source download, loop or timer.
 * A killed action after claim already owns a durable reconciliation watchdog. */
export const drive = internalAction({
  args: { ...channel, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input): Promise<string | null> => {
    const selected: LandingClaim | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedLandingDriver:claim'),
      input,
    );
    if (!selected) return null;
    const { projectId, channel, owner, token, submissionId, attemptId } = selected;
    return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingDriver:advance'), {
      projectId,
      channel,
      owner,
      token,
      submissionId,
      attemptId,
    });
  },
});
