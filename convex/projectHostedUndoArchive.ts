// SPDX-License-Identifier: Apache-2.0
'use node';
import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { report } from './errors';
import { loadJournalSegment } from './projectJournalObject';
import type { JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';

/** Only the server reads archived Lane records. The same mutation rechecks authority and pins
 * after each exact segment is fetched, so archival I/O cannot widen the write it permits. */
export const undo = action({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const segments: string[] = [];
    const loaded = new Set<string>();
    try {
      for (;;) {
        try {
          return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedUndo:archived'), {
            ...input,
            segments,
          });
        } catch (error) {
          if (!(error instanceof ConvexError) || typeof error.data?.index !== 'string') throw error;
          const index: JournalIndex = JSON.parse(error.data.index);
          invariant(!loaded.has(index.pointer.sha256), 'WORK_STALE', 'The retained undo history changed.');
          loaded.add(index.pointer.sha256);
          segments.push(await loadJournalSegment(input.projectId, index));
        }
      }
    } catch (error) {
      return report(error);
    }
  },
});
