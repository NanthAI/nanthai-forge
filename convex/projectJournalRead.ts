// SPDX-License-Identifier: Apache-2.0
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
    await guard(ctx, 'cli');
    const journalLoaded = input.segments.map(text => journalSegmentSchema.parse(JSON.parse(text)));
    const selected = { ...ctx, journalLoaded, journalPrivate: true };
    if (input.query === 'projectRecoveryHosted:page')
      return journalRecoveryRead(selected, { ...JSON.parse(input.request), projectId: input.projectId });
    if (input.query === 'projectWork:events')
      return canonicalPayload(
        await journalWorkEvents(selected, { ...JSON.parse(input.request), projectId: input.projectId }),
      );
    if (input.query === 'projectHostedRecordReads:read') return journalRecordRead(selected, input);
    return journalProvenanceRead(selected, input);
  },
});
