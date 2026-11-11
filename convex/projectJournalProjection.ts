// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { getJournalSegment } from './projectJournalObject';
import type { JournalIndex } from '../src/journal-segment';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** Rebuild a disposable snapshot page from verified canonical versions, rechecking current
 * access inside the original transaction after IO. Live rebuilds remain one mutation. */
export const rebuildPage = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    snapshotId: v.string(),
    page: v.number(),
    operationId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, input) => {
    const segments: string[] = [],
      seen = new Set<string>();
    for (;;) {
      const result = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedProjection:rebuildPage'),
        { ...input, segments },
      );
      if (typeof result === 'number') return result;
      const reply = JSON.parse(result) as { journalHistory?: boolean; index?: JournalIndex };
      invariant(
        reply.index && reply.journalHistory && !seen.has(reply.index.pointer.sha256),
        'WORK_STALE',
        'Journal projection selection changed; retry the original page.',
      );
      seen.add(reply.index.pointer.sha256);
      segments.push(canonicalPayload(await getJournalSegment(input.projectId, reply.index)));
    }
  },
});
