// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { coordinationAction } from './cliServer';
import { readJournalHistory } from './projectJournalActions';
/** The existing coordination credential scope continues to read archived detail. */
export const history = coordinationAction({
  args: {
    projectId: v.id('hostedProjects'),
    query: v.union(
      v.literal('projectCoordination:feed'),
      v.literal('projectCoordination:recent'),
      v.literal('projectCoordinationReads:related'),
      v.literal('projectCoordinationReads:inbox'),
    ),
    request: v.string(),
  },
  returns: v.string(),
  handler: readJournalHistory,
});
