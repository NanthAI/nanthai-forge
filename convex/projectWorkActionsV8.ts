// SPDX-License-Identifier: Apache-2.0
import type { StoredWorkEvent } from './projectWorkEventStore';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { report } from './errors';
import { hostedWorkEventDocument } from './schema';
import { caller, runWorkCommand } from './projectWorkCommandRun';
import { indexedCommand, NodeCommandRequired } from './projectWorkIndexedCommand';

/** `projectWorkActions:command` for the 64 MiB V8 runtime (Issue 85801d6f). The command waits on about
 * ten Convex round trips and reads under 100 KB, so a 512 MiB Node action billed 8x the memory-time for
 * the same wait. Acceptance and anchored notes need Node-only readers, and a command whose rows pass the
 * V8 budget would not leave headroom; both run in the Node action, which holds the same logic. */
export const command = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    revision: v.number(),
    command: v.string(),
  },
  returns: hostedWorkEventDocument,
  handler: async (ctx, input): Promise<StoredWorkEvent> => {
    try {
      const owner = await caller(ctx);
      try {
        return await runWorkCommand(ctx, input, owner, (parsed, request) =>
          indexedCommand(ctx, input, owner, parsed, request),
        );
      } catch (error) {
        if (!(error instanceof NodeCommandRequired)) throw error;
      }
      return await ctx.runAction(internal.projectWorkActions.commandNode, { ...input, owner });
    } catch (error) {
      return report(error);
    }
  },
});
