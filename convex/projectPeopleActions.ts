// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { caller } from './projectWorkActions';
import { personDisplayName } from './projectPeople';
import { report } from './errors';
/** No directory lookup: identities must already be visible in the authorized project. */
export const labels = action({
  args: { projectId: v.id('hostedProjects'), actors: v.array(v.string()) },
  returns: v.array(v.object({ actor: v.string(), displayName: v.string() })),
  handler: async (ctx, input): Promise<{ actor: string; displayName: string }[]> => {
    try {
      const reader = await caller(ctx),
        pins = { ...input, reader };
      const actors = await ctx.runQuery(internal.projectActorNames.authorize, pins);
      const labels = await Promise.all(
        actors.map(async actor => ({ actor, displayName: await personDisplayName(actor) })),
      );
      await ctx.runMutation(internal.projectActorNames.remember, {
        projectId: input.projectId,
        reader,
        labels,
      });
      await ctx.runQuery(internal.projectActorNames.authorize, pins);
      return labels;
    } catch (error) {
      return report(error);
    }
  },
});
