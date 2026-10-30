// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { recordHead } from './projectHostedRecords';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Lane Intent status for planned Issues: one indexed head read per id, no bodies. Ids without a
 * started Intent are absent. Lets a backlog read show which Issues are finished, without a scan. */
export const intentStates = query({
  args: { projectId: v.id('hostedProjects'), ids: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, { projectId, ids }) => {
    try {
      await recordCaller(ctx, projectId);
      invariant(ids.length <= 100, 'BAD_ARGUMENT', 'Read at most 100 Issues at a time.');
      const states: Record<string, string> = {};
      for (const id of new Set(ids)) {
        const head = await recordHead(ctx, projectId, 'intent', id);
        if (head) states[id] = head.status;
      }
      return canonicalPayload(states);
    } catch (error) {
      return report(error);
    }
  },
});
