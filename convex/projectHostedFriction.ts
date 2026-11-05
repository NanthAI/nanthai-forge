import { digest } from '../src/portable-hash';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
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
import {
  frictionInputSchema,
  frictionEventSchema,
  frictionListSchema,
  hostedFrictionTriageSchema,
  frictionTriageProblem,
  type FrictionTriageState,
} from '../src/friction-types';
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
      let value: unknown;
      try {
        value = JSON.parse(input);
      } catch {
        invariant(
          false,
          'BAD_ARGUMENT',
          'request: expected a JSON object with title, detail, area and operationId UUID; laneId is optional. Correct the JSON and retry the same operation.',
        );
      }
      const parsed = frictionInputSchema.required({ operationId: true }).safeParse(value);
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        `Invalid friction parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}. Run nforge agent ROOT friction --help, correct the named fields and retry the original operation.`,
      );
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

const parseRequest = <T extends z.ZodType>(schema: T, input: string, what: string): z.infer<T> => {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    invariant(false, 'BAD_ARGUMENT', `request: expected a JSON object for ${what}.`);
  }
  const parsed = schema.safeParse(value);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid ${what} parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}. Run nforge agent ROOT ${what} --help, correct the named fields and retry.`,
  );
  return parsed.data;
};
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text);
/** One bounded, newest-first page of captured friction with its current triage status. The scan is
 * one indexed page of at most `limit` rows; filters apply inside it, so a sparse match can return
 * fewer items with a nextCursor. Idle cost is zero: nothing calls this unless a caller asks. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      await recordCaller(ctx, projectId);
      const filter = parseRequest(frictionListSchema, input, 'friction-list');
      const page = await ctx.db
        .query('projectHostedFriction')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate({ ...recordPageOptions(filter.cursor), numItems: filter.limit });
      const needle = filter.search?.toLowerCase();
      const items = [];
      for (const row of page.page) {
        const event = frictionEventSchema.safeParse(JSON.parse(row.value));
        if (!event.success || event.data.kind !== 'capture') continue;
        const f = event.data;
        const state: FrictionTriageState | undefined = row.triage ? JSON.parse(row.triage) : undefined;
        const status = state?.status ?? 'open';
        if (
          (filter.status !== 'all' && status !== filter.status) ||
          (filter.area && f.area !== filter.area) ||
          (filter.laneId && f.laneId !== filter.laneId) ||
          (needle && !`${f.title}\n${f.detail}`.toLowerCase().includes(needle))
        )
          continue;
        items.push({
          id: f.id,
          ...(f.laneId ? { laneId: f.laneId } : {}),
          title: clip(f.title, 200),
          area: f.area,
          at: f.at,
          detail: clip(f.detail, 400),
          status,
          ...(state?.reason ? { reason: clip(state.reason, 400) } : {}),
          ...(state?.planningItemId ? { planningItemId: state.planningItemId } : {}),
          ...(state?.laneId ? { fixedByLaneId: state.laneId } : {}),
        });
      }
      return canonicalPayload({
        items,
        scanned: page.page.length,
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    } catch (error) {
      return report(error);
    }
  },
});
const triageRequest = hostedFrictionTriageSchema.extend({ operationId: z.uuid() }).strict();
/** Dismiss (dropped), link to an Issue (planned + planningItemId), mark fixed or reopen. Append-only
 * event plus one patch per id (at most 50); a replay of the same operation returns the stored event. */
export const triage = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      const { actor } = await recordCaller(ctx, projectId, true);
      const command = parseRequest(triageRequest, input, 'friction-triage');
      const problem = frictionTriageProblem(command);
      invariant(!problem, 'BAD_ARGUMENT', `Invalid friction-triage parameters: ${problem}`);
      const request = digest(JSON.stringify(command));
      const old = await frictionRow(ctx, projectId, command.operationId);
      if (old) {
        replayRequest(old.request, request);
        return old.value;
      }
      for (const id of command.frictionIds) {
        const row = await frictionRow(ctx, projectId, id);
        invariant(row && JSON.parse(row.value).kind === 'capture', 'NOT_FOUND', `Friction ${id} not found.`);
      }
      if (command.laneId)
        invariant(await recordHead(ctx, projectId, 'lane', command.laneId), 'NOT_FOUND', 'Lane not found.');
      const record = frictionEventSchema.parse({
        ...command,
        id: command.operationId,
        kind: 'triage',
        request,
        at: new Date().toISOString(),
      });
      await appendFriction(ctx, projectId, actor, record);
      return canonicalPayload(record);
    } catch (error) {
      return report(error);
    }
  },
});
