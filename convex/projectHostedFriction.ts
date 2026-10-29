import { digest } from '../src/portable-hash';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import {
  recordCaller,
  frictionRow,
  appendFriction,
  replayRequest,
  recordPageOptions,
} from './projectHostedFrictionStore';
import { frictionInputSchema, frictionEventSchema } from '../src/friction-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { recordHead } from './projectHostedRecords';
import { invariant } from '../src/errors';
import { report } from './errors';
export const capture = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      const { actor } = await recordCaller(ctx, projectId, true);
      const parsed = frictionInputSchema.required({ operationId: true }).safeParse(JSON.parse(input));
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send the original friction inputs and operation UUID.');
      const command = parsed.data,
        request = digest(JSON.stringify(command));
      const old = await frictionRow(ctx, projectId, command.operationId);
      if (old) {
        replayRequest(old.request, request);
        return old.value;
      }
      if (command.laneId)
        invariant(await recordHead(ctx, projectId, 'lane', command.laneId), 'NOT_FOUND', 'Lane not found.');
      const record = frictionEventSchema.parse({
        ...command,
        id: command.operationId,
        kind: 'capture',
        request,
        at: new Date().toISOString(),
        count: 1,
      });
      await appendFriction(ctx, projectId, actor, record);
      return canonicalPayload(record);
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
        .query('projectHostedFriction')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId))
        .paginate(recordPageOptions(cursor));
      return canonicalPayload({ ...page, page: page.page.map(row => JSON.parse(row.value)) });
    } catch (error) {
      return report(error);
    }
  },
});
