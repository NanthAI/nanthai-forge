// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readHostedRecord, hostedRecordBody } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';

/** One bounded indexed page, selected metadata only; no source objects or idle work. */
export const list = query({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()), limit: v.number() },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, limit }) => {
    try {
      invariant(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        'BAD_ARGUMENT',
        'limit: expected an integer from 1 to 100. Run lanes {"limit":50}.',
      );
      invariant(
        cursor === null || cursor.startsWith('forge-lanes-v1:'),
        'BAD_ARGUMENT',
        'cursor: expected the continueCursor from lanes. Run lanes {} to restart the page.',
      );
      const providerCursor = cursor === null ? null : cursor.slice('forge-lanes-v1:'.length);
      const { actor } = await recordCaller(ctx, projectId);
      const page = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_status', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
        )
        .order('desc')
        .paginate({ cursor: providerCursor, numItems: limit, maximumRowsRead: limit });
      const lanes = [];
      for (const head of page.page) {
        // Includes staged lifecycle overlays, so completed cascades never appear live.
        const row = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: head.key });
        if (!row) continue;
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        if (lane.state !== 'active') continue;
        const intent = await readHostedRecord(ctx, { projectId, actor, kind: 'intent', key: lane.intentId });
        const [saved] = await ctx.db
          .query('projectHostedRecords')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'save').eq('parent', lane.id),
          )
          .order('desc')
          .take(1);
        const [candidate] = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'candidate').eq('parent', lane.intentId),
          )
          .order('desc')
          .take(1);
        const [landing] = candidate
          ? await ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_candidate_and_sequence', q =>
                q.eq('projectId', projectId).eq('candidateId', candidate.key),
              )
              .order('desc')
              .take(1)
          : [];
        lanes.push({
          laneId: lane.id,
          intentId: lane.intentId,
          intent: intent ? JSON.parse(intent.value).outcome : null,
          actor: lane.actor,
          state: lane.state,
          head: lane.head,
          lastSaveAt: saved ? JSON.parse(await hostedRecordBody(ctx, saved)).at : null,
          landing: landing
            ? { submissionId: landing.submissionId, state: landing.phase, scope: 'intent' }
            : null,
        });
      }
      return canonicalPayload({
        page: lanes,
        isDone: page.isDone,
        continueCursor: page.isDone ? null : `forge-lanes-v1:${page.continueCursor}`,
      });
    } catch (error) {
      if (error instanceof Error && /(?:InvalidCursor|invalid cursor|pagination cursor)/i.test(error.message))
        return report(
          new ForgeError(
            'BAD_ARGUMENT',
            'cursor: expected the continueCursor from lanes. Run nforge agent ROOT lanes {} to restart the page.',
          ),
        );
      return report(error);
    }
  },
});
