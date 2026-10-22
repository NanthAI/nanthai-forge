// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { controlHostedCheck } from './projectHostedCheckDispatch';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const control = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), command: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(
        await controlHostedCheck(ctx, { ...input, command: JSON.parse(input.command) }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
export const callback = internalMutation({
  args: { projectId: v.id('hostedProjects'), callback: v.string(), signature: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const run = await receiveHostedCheckCallback(
        ctx,
        { ...input, callback: JSON.parse(input.callback) },
        keyId => {
          const key = process.env[`FORGE_HOSTED_CHECK_KEY_${keyId}`];
          invariant(key, 'RUNNER_UNAVAILABLE', 'Trusted check callback key is unavailable.');
          return key;
        },
      );
      return canonicalPayload(run);
    } catch (error) {
      return report(error);
    }
  },
});
