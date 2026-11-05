import { digest } from '../src/portable-hash';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation } from './cliServer';
import { likelyPlanningDuplicates } from './projectHostedPlanningSearch';
import {
  recordCaller,
  frictionRow,
  frictionHints,
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
      const { actor, project } = await recordCaller(ctx, projectId, true);
      const parsed = frictionInputSchema.required({ operationId: true }).safeParse(JSON.parse(input));
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send the original friction inputs and operation UUID.');
      const command = parsed.data,
        request = digest(JSON.stringify(command));
      const old = await frictionRow(ctx, projectId, command.operationId);
      if (old) {
        replayRequest(old.request, request);
        const savedHints =
          old.likelyDuplicates ?? (await frictionHints(ctx, projectId, command.operationId))?.value;
        return savedHints === undefined
          ? old.value
          : canonicalPayload({ ...JSON.parse(old.value), likelyDuplicates: JSON.parse(savedHints) });
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
      const likelyDuplicates = await likelyPlanningDuplicates(
        ctx,
        project,
        `${command.title} ${command.detail}`,
      );
      await appendFriction(ctx, projectId, actor, record, canonicalPayload(likelyDuplicates));
      return canonicalPayload({ ...record, likelyDuplicates });
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
