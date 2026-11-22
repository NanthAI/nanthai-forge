// SPDX-License-Identifier: Apache-2.0
import { journalWorkStoreCompare } from './projectWorkStore';
import { journalCoordinationFeed, journalCoordinationRecent } from './projectCoordination';
import { journalCoordinationRelated, journalCoordinationInbox } from './projectCoordinationReads';
import { journalWorkRecordsRead } from './projectWorkIndex';
import { journalLaneRead } from './projectHostedLanes';
import { journalLaneHistoryRead } from './projectHostedLaneHistory';
import { invariant } from '../src/errors';
import { journalRecoveryRead } from './projectRecoveryHosted';
import { journalWorkEvents } from './projectWork';
import { canonicalPayload } from '../src/hosted-source-operation';
import { v } from 'convex/values';
import { internalQuery } from './server';
import { guard } from './cliServer';
import { decodeRequest, publicWorkResult, publicWorkSelected } from './publicWorkReads';
import { journalRecordRead } from './projectHostedRecordReads';
import { journalProvenanceRead } from './projectHostedProvenanceRead';
import { parseLoadedJournalSegment } from './projectJournalStore';
import type { LoadedLandingNote } from './projectIntentLandingNoteArchive';
const NESTED_READERS = new Set(['projectHostedRecordReads:read', 'projectHostedProvenanceRead:read']);
/** Raw verified rows travel only across the private server boundary. The action maps current identities. */
export const read = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.string(),
    request: v.string(),
    segments: v.array(v.string()),
    landingNotes: v.optional(v.array(v.string())),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    // Only the record and provenance readers read a nested `request` (a JSON string); every other reader reads the
    // flat fields, so a nested one is dropped before the selection check and the projection see it.
    // Decoded as the readers decode it; anything but a JSON object is the caller's error, never a TypeError.
    const command = decodeRequest(input.request);
    invariant(command, 'BAD_ARGUMENT', 'A journal request must be a JSON object.');
    if (NESTED_READERS.has(input.query))
      invariant(
        command.request === undefined || typeof command.request === 'string',
        'BAD_ARGUMENT',
        'A nested request must be a JSON string.',
      );
    else if ('request' in command) {
      delete command.request;
      input = { ...input, request: JSON.stringify(command) };
    }
    // The same boundary as a live read: a role-less viewer's selection of hidden plan work runs as an absent one.
    const args = { ...command, projectId: input.projectId };
    const result = await publicWorkSelected(ctx, args, selected => {
      if (selected === args) return journalResult(ctx, input);
      const request = { ...(selected as Record<string, unknown>) };
      delete request.projectId;
      return journalResult(ctx, { ...input, request: JSON.stringify(request) });
    });
    return (await publicWorkResult(ctx, args, result)) as string;
  },
});

async function journalResult(
  ctx: import('./_generated/server').QueryCtx,
  input: {
    projectId: import('./_generated/dataModel').Id<'hostedProjects'>;
    query: string;
    request: string;
    segments: string[];
    landingNotes?: string[];
  },
) {
  await guard(ctx, input.query.startsWith('projectCoordination') ? 'coordination' : 'cli');
  const journalLoaded = input.segments.map(parseLoadedJournalSegment);
  const landingNotesLoaded =
    input.query === 'projectWorkIndex:records'
      ? (input.landingNotes ?? []).map(text => JSON.parse(text) as LoadedLandingNote)
      : undefined;
  const selected = { ...ctx, journalLoaded, journalPrivate: true, landingNotesLoaded };
  const command = JSON.parse(input.request);
  const original = { ...command, projectId: input.projectId };
  if (input.query === 'projectCoordination:recent')
    return canonicalPayload(await journalCoordinationRecent(selected, original));
  if (input.query === 'projectCoordination:feed')
    return canonicalPayload(await journalCoordinationFeed(selected, original));
  if (input.query === 'projectCoordinationReads:inbox')
    return canonicalPayload(await journalCoordinationInbox(selected, original));
  if (input.query === 'projectCoordinationReads:related')
    return canonicalPayload(await journalCoordinationRelated(selected, original));
  if (input.query === 'projectWorkStore:compare') return journalWorkStoreCompare(selected, original);
  if (input.query === 'projectWorkIndex:records')
    return canonicalPayload(await journalWorkRecordsRead(selected, original));
  if (input.query === 'projectHostedLaneHistory:read') return journalLaneHistoryRead(selected, original);
  if (input.query === 'projectHostedLanes:detail') return journalLaneRead(selected, original);
  if (input.query === 'projectRecoveryHosted:page')
    return journalRecoveryRead(selected, { ...JSON.parse(input.request), projectId: input.projectId });
  if (input.query === 'projectWork:events')
    return canonicalPayload(
      await journalWorkEvents(selected, { ...JSON.parse(input.request), projectId: input.projectId }),
    );
  const request = typeof command.request === 'string' ? command.request : input.request;
  if (input.query === 'projectHostedRecordReads:read')
    return journalRecordRead(selected, { ...input, request });
  invariant(
    input.query === 'projectHostedProvenanceRead:read',
    'BAD_ARGUMENT',
    'Select a supported journal reader.',
  );
  return journalProvenanceRead(selected, { ...input, request });
}
