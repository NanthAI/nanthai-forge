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
import { internalQuery } from './_generated/server';
import { guard } from './cliServer';
import { journalRecordRead } from './projectHostedRecordReads';
import { journalProvenanceRead } from './projectHostedProvenanceRead';
import { journalSegmentSchema } from '../src/journal-segment';
/** Raw verified rows travel only across the private server boundary. The action maps current identities. */
export const read = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.string(),
    request: v.string(),
    segments: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    await guard(ctx, input.query.startsWith('projectCoordination') ? 'coordination' : 'cli');
    const journalLoaded = input.segments.map(text => journalSegmentSchema.parse(JSON.parse(text)));
    const selected = { ...ctx, journalLoaded, journalPrivate: true };
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
  },
});
