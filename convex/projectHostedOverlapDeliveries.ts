// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation, query } from './cliServer';
import { recordCaller, recordRequest, recordPageOptions } from './projectHostedFrictionStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import { report } from './errors';

const delivery = z
  .object({
    laneId: z.uuid(),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    surface: z.enum(['start', 'save', 'sync', 'compose', 'finish']),
    count: z.number().int().min(1),
    coverage: z.string().max(40),
    items: z
      .array(z.object({ noticeId: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().max(1024) }))
      .min(1)
      .max(5),
  })
  .strict();

/** Metric 5.4 "delivered": an overlap notice was returned to the Lane's actor on an agent response.
 * One row per Lane head, so a replayed finish or a repeated read never counts twice; the ack record
 * joins through the same `hook:` delivery id. Written only when a notice exists: idle is 0 calls. */
export const record = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      const { actor } = await recordCaller(ctx, projectId, true);
      const parsed = delivery.safeParse(JSON.parse(input));
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send a Lane, head, surface and 1-5 overlap notices.');
      const id = digest(JSON.stringify(['overlap-delivery', parsed.data.laneId, parsed.data.head]));
      const old = await ctx.db
        .query('projectHostedOverlapDeliveries')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', id))
        .unique();
      if (old) return old.value;
      const value = canonicalPayload({
        type: 'overlap-delivery',
        id,
        at: new Date().toISOString(),
        via: 'lifecycle',
        ...parsed.data,
        items: parsed.data.items.map(item => ({
          ...item,
          deliveryId: `hook:${digest(JSON.stringify([parsed.data.laneId, item.noticeId]))}`,
        })),
      });
      await ctx.db.insert('projectHostedOverlapDeliveries', {
        projectId,
        id,
        actor,
        laneId: parsed.data.laneId,
        request: recordRequest(parsed.data),
        value,
      });
      return value;
    } catch (error) {
      return report(error);
    }
  },
});

export const list = query({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor }) => {
    try {
      await recordCaller(ctx, projectId);
      const page = await ctx.db
        .query('projectHostedOverlapDeliveries')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId))
        .paginate(recordPageOptions(cursor));
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({ ...JSON.parse(row.value), actor: row.actor })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
