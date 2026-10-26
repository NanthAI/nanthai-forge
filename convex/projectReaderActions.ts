// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { checkForgeUser } from './sharingActions';
import { caller } from './projectWorkActions';
import { report } from './errors';
const save = makeFunctionReference<
  'mutation',
  {
    projectId: Id<'hostedProjects'>;
    owner: string;
    reader: string;
    present: boolean;
    operationId: string;
  },
  null
>('projectReaders:set');
/** Owner-only, retry-safe reader sharing; no contributor/write permission is created. */
export const set = action({
  args: {
    projectId: v.id('hostedProjects'),
    reader: v.string(),
    present: v.boolean(),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    try {
      const owner = await caller(ctx);
      await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
      const reader = input.present ? await checkForgeUser(input.reader) : input.reader.trim();
      // Rechecks owner, project state and existing write grants after the provider round-trip.
      return await ctx.runMutation(save, { ...input, reader, owner });
    } catch (error) {
      return report(error);
    }
  },
});
