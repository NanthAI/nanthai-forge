// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { getJournalSegment } from './projectJournalObject';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';
import { report } from './errors';
/** One action, one verified GET per segment. Every projection rechecks current access after IO.
 * No object keys, signed URLs, transaction pins or raw archive documents cross the client boundary. */
export const history = action({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.union(
      v.literal('projectHostedRecordReads:read'),
      v.literal('projectHostedProvenanceRead:read'),
      v.literal('projectRecoveryHosted:page'),
    ),
    request: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const args = { ...input, segments: [] as string[] };
      const seen = new Set<string>();
      for (;;) {
        const text: string = await ctx.runQuery(
          makeFunctionReference<'query'>('projectJournalRead:read'),
          args,
        );
        const reply = JSON.parse(text) as { journalHistory?: true; index?: JournalIndex };
        if (!reply.journalHistory) return text;
        invariant(
          reply.index && !seen.has(reply.index.pointer.sha256),
          'WORK_STALE',
          'Journal selection changed during the read; retry the original request.',
        );
        seen.add(reply.index.pointer.sha256);
        args.segments.push(canonicalPayload(await getJournalSegment(input.projectId, reply.index)));
      }
    } catch (error) {
      return report(error);
    }
  },
});
