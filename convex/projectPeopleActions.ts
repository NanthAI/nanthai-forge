// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { caller } from './projectWorkActions';
import { report } from './errors';
/** Identities must already be visible in the authorized project. */
export const labels = action({
  args: { projectId: v.id('hostedProjects'), actors: v.array(v.string()) },
  returns: v.array(v.object({ actor: v.string(), displayName: v.string() })),
  handler: async (ctx, input): Promise<{ actor: string; displayName: string }[]> => {
    try {
      const reader = await caller(ctx),
        pins = { ...input, reader };
      // People are labelled by Forge handle only; the shared mapping turns both fields into
      // the handle for members and removes them for readers. No provider directory lookup.
      const actors = await ctx.runQuery(internal.projectActorNames.authorize, pins);
      return actors.map(actor => ({ actor, displayName: actor }));
    } catch (error) {
      return report(error);
    }
  },
});
