// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action, type ActionCtx } from './cliServer';
import { loadJournalSegment } from './projectJournalObject';
import type { Id } from './_generated/dataModel';
import type { JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';
import { report } from './errors';
import { loadArchivedLandingNotes } from './projectIntentLandingNoteArchiveRead';
import type { ArchivedNotePin } from './projectIntentLandingNoteArchive';
/** One action, one verified GET per segment. Every projection rechecks current access after IO.
 * No object keys, signed URLs, transaction pins or raw archive documents cross the client boundary. */
export const history = action({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.union(
      v.literal('projectHostedRecordReads:read'),
      v.literal('projectHostedProvenanceRead:read'),
      v.literal('projectRecoveryHosted:page'),
      v.literal('projectWorkIndex:records'),
      v.literal('projectWorkStore:compare'),
      v.literal('projectHostedLaneHistory:read'),
      v.literal('projectHostedLanes:detail'),
    ),
    request: v.string(),
  },
  returns: v.string(),
  handler: readJournalHistory,
});

export async function readJournalHistory(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; query: string; request: string },
) {
  try {
    const segments: string[] = [];
    let landingNotes: string[] | undefined;
    const seen = new Set<string>();
    for (;;) {
      const text: string = await ctx.runQuery(makeFunctionReference<'query'>('projectJournalRead:read'), {
        ...input,
        segments,
        ...(landingNotes ? { landingNotes } : {}),
      });
      const reply = JSON.parse(text) as {
        journalHistory?: true;
        index?: JournalIndex;
        landingNotePins?: ArchivedNotePin[];
      };
      if (!reply.journalHistory) return text;
      if (reply.landingNotePins) {
        invariant(
          input.query === 'projectWorkIndex:records' && landingNotes === undefined,
          'WORK_STALE',
          'Landing note selection changed during the read; retry the original request.',
        );
        landingNotes = (await loadArchivedLandingNotes(input.projectId, reply.landingNotePins)).map(note =>
          JSON.stringify(note),
        );
        continue;
      }
      invariant(
        reply.index && !seen.has(reply.index.pointer.sha256),
        'WORK_STALE',
        'Journal selection changed during the read; retry the original request.',
      );
      seen.add(reply.index.pointer.sha256);
      segments.push(await loadJournalSegment(input.projectId, reply.index));
    }
  } catch (error) {
    return report(error);
  }
}
