// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { recordHead } from './projectHostedRecords';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isPlanningPrefix, planningIdMaxCandidates } from '../src/planning-id';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { intentFinished, maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { report } from './errors';

/** Lane Intent status for planned Issues: one indexed head read per id (one more per follow-up Intent), no bodies. Ids without a
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
        let head = await recordHead(ctx, projectId, 'intent', id);
        // A finished Intent whose Issue continued (e4a71127) reports the latest Intent's state.
        let at = id;
        for (let hop = 0; head && intentFinished(head.status) && hop < maxIntentChain; hop++) {
          const next = await recordHead(ctx, projectId, 'intent', successorIntentId(at));
          if (!next) break;
          head = next;
          at = successorIntentId(at);
        }
        if (head) states[id] = head.status;
      }
      return canonicalPayload(states);
    } catch (error) {
      return report(error);
    }
  },
});

/** Full ids of the planning items whose id starts with `prefix` (8+ hex characters): one range read
 * on the existing by_generation_and_collection_and_key index, at most one key past the candidate
 * limit. No scan, no search, no bodies; `more` says there are further matches. */
export const resolveId = query({
  args: { projectId: v.id('hostedProjects'), prefix: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, prefix }) => {
    try {
      const { project } = await recordCaller(ctx, projectId);
      invariant(
        isPlanningPrefix(prefix) && prefix === prefix.toLowerCase(),
        'BAD_ARGUMENT',
        'prefix must be 8 to 35 lowercase hex characters.',
      );
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'The Work index is unavailable.');
      const rows = await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_collection_and_key', q =>
          q
            .eq('generationId', recordPartition(generation))
            .eq('collection', 'planningItems')
            .gte('key', prefix)
            .lt('key', `${prefix}\uffff`),
        )
        .take(planningIdMaxCandidates + 1);
      return canonicalPayload({
        ids: rows.slice(0, planningIdMaxCandidates).map(row => row.key),
        more: rows.length > planningIdMaxCandidates,
      });
    } catch (error) {
      return report(error);
    }
  },
});
