// SPDX-License-Identifier: Apache-2.0
import { readNowOverlaps } from './projectNowOverlaps';
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { recordCaller, recordRequest, replayRequest, recordPageOptions } from './projectHostedFrictionStore';
import { hostedAckBatchSchema } from '../src/hosted-record-input';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import { report } from './errors';
export const append = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      const { actor } = await recordCaller(ctx, projectId, true);
      const parsed = hostedAckBatchSchema.safeParse(JSON.parse(input));
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Send an operation UUID and a batch of up to 100 overlap answers.',
      );
      const batch = parsed.data,
        request = recordRequest(batch);
      const old = await ctx.db
        .query('projectHostedAckBatches')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', batch.operationId))
        .unique();
      if (old) {
        replayRequest(old.request, request);
        return old.value;
      }
      const answers = [];
      for (const answer of batch.answers) {
        const original = await ctx.db
          .query('projectHostedOverlapAcks')
          .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', answer.operationId))
          .unique();
        const identity = recordRequest(answer);
        if (original) {
          replayRequest(original.request, identity);
          answers.push(JSON.parse(original.value));
          continue;
        }
        const record = {
          ...answer,
          type: 'overlap-answer',
          id: answer.operationId,
          at: new Date().toISOString(),
          deliveryId: `hook:${digest(JSON.stringify([answer.laneId, answer.noticeId]))}`,
          disposition: answer.choice === 'split' ? 'routed-around' : 'acknowledged',
        };
        await ctx.db.insert('projectHostedOverlapAcks', {
          projectId,
          actor,
          id: answer.operationId,
          request: identity,
          value: canonicalPayload(record),
          laneId: answer.laneId,
          noticeId: answer.noticeId,
        });
        answers.push(record);
      }
      const value = canonicalPayload({ status: 'recorded', answers });
      await ctx.db.insert('projectHostedAckBatches', {
        projectId,
        actor,
        id: batch.operationId,
        request,
        value,
      });
      return value;
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    signals: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, signals }) => {
    try {
      await recordCaller(ctx, projectId);
      const page = await ctx.db
        .query('projectHostedOverlapAcks')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId))
        .paginate(recordPageOptions(cursor));
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({ ...JSON.parse(row.value), ...(signals ? { actor: row.actor } : {}) })),
        ...(signals ? { signals: await readNowOverlaps(ctx, projectId) } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
