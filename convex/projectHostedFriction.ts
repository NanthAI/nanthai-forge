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
  resolveFriction,
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

/** One indexed read: what a friction id is and where it was triaged. Only a failed planning comment
 * asks (the CLI points the caller at the Issue to comment on); nothing calls this on a healthy path. */
export const lookup = query({
  args: { projectId: v.id('hostedProjects'), id: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, id }) => {
    try {
      await recordCaller(ctx, projectId);
      const row = await frictionRow(ctx, projectId, id);
      const event = row ? frictionEventSchema.safeParse(JSON.parse(row.value)) : null;
      if (!row || !event?.success || event.data.kind !== 'capture') return canonicalPayload({ found: false });
      const state: FrictionTriageState | undefined = row.triage ? JSON.parse(row.triage) : undefined;
      return canonicalPayload({
        found: true,
        status: state?.status ?? 'open',
        ...(state?.planningItemId ? { planningItemId: state.planningItemId } : {}),
      });
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
type FrictionRow = { value: string; triage?: string };
/** The list/lookup shape of one captured friction, or null for a count or triage event row. */
function frictionItem(row: FrictionRow) {
  const event = frictionEventSchema.safeParse(JSON.parse(row.value));
  if (!event.success || event.data.kind !== 'capture') return null;
  const f = event.data;
  const state: FrictionTriageState | undefined = row.triage ? JSON.parse(row.triage) : undefined;
  return {
    search: `${f.title}\n${f.detail}`.toLowerCase(),
    item: {
      id: f.id,
      ...(f.laneId ? { laneId: f.laneId } : {}),
      title: clip(f.title, 200),
      area: f.area,
      at: f.at,
      detail: clip(f.detail, 400),
      status: state?.status ?? 'open',
      ...(state?.reason ? { reason: clip(state.reason, 400) } : {}),
      ...(state?.planningItemId ? { planningItemId: state.planningItemId } : {}),
      ...(state?.laneId ? { fixedByLaneId: state.laneId } : {}),
    },
  };
}
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
      if (filter.id) {
        // One id or prefix: one indexed read, no page scan, whatever its status or age.
        const found = frictionItem(await resolveFriction(ctx, projectId, filter.id));
        return canonicalPayload({ items: found ? [found.item] : [], scanned: 1, nextCursor: null });
      }
      const page = await ctx.db
        .query('projectHostedFriction')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate({ ...recordPageOptions(filter.cursor), numItems: filter.limit });
      const needle = filter.search?.toLowerCase();
      const items = [];
      for (const row of page.page) {
        const item = frictionItem(row);
        if (
          !item ||
          (filter.status !== 'all' && item.item.status !== filter.status) ||
          (filter.area && item.item.area !== filter.area) ||
          (filter.laneId && item.item.laneId !== filter.laneId) ||
          (needle && !item.search.includes(needle))
        )
          continue;
        items.push(item.item);
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
      const frictionIds: string[] = [];
      for (const ref of command.frictionIds)
        frictionIds.push((await resolveFriction(ctx, projectId, ref)).id);
      if (command.laneId)
        invariant(await recordHead(ctx, projectId, 'lane', command.laneId), 'NOT_FOUND', 'Lane not found.');
      const record = frictionEventSchema.parse({
        ...command,
        frictionIds: [...new Set(frictionIds)],
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
