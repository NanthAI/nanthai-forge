// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
