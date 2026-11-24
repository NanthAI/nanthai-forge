// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Plan screen's one read (Items d3357f40, b7a0dff1): bounded display rows and Initiative counts. It uses
// compact planning pages once covered and indexed search roots otherwise. Members can use the same complete
// Initiative tallies as CLI/MCP. It never hydrates bodies or writes. Members see hidden Items with their mark.
import { getDocumentSize, v } from 'convex/values';
import { planQuery as query } from './cliServer';
import { finishReadReader, finishReadSourceDb } from './projectFinishReadReader';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { report } from './errors';
import { invariant } from '../src/errors';
import { hostedOperationRow } from './projectHostedOperationLookup';
import { hostedOperationSchema } from '../src/hosted-source-operation';
import { isLive, type PlanRow } from '../src/planning-model';
export { planViewRow } from './projectPlanRows';
import { markPlanPage } from './projectPlanLaneMarks';
import { decodePlanPage, PLAN_ROWS, planParent, planViewRow } from './projectPlanRows';
import { coveredInitiativeTallies, zeroTally } from './projectPlanCountsStore';

/** Live Items read per status, Initiatives read, and settled Items counted per shown Initiative; beyond these the
 * screen says "at least". On the dogfood board (2026-11-17) the read is 22 Initiatives, 271 live Items and 31 settled
 * Items of the 4 live Initiatives. */
export const PLAN_LIVE_LIMIT = 500;
export const PLAN_INITIATIVE_LIMIT = 200;
export const PLAN_SETTLED_LIMIT = 1000;
const liveStatuses = ['proposed', 'open', 'in-progress'] as const;

export const planViewResult = v.object({
  /** JSON PlanRow[] (src/planning-model.ts): Initiatives first, then live Items. */
  rows: v.string(),
  /** Some live Items or Initiatives were not read. */
  more: v.boolean(),
  /** The member fallback may have incomplete live counts even when all available rows fit. */
  liveMore: v.optional(v.boolean()),
  /** Bounded history or, when `live` is present, all five exact counts for a loaded Initiative. */
  settled: v.array(
    v.object({
      initiativeId: v.string(),
      done: v.number(),
      dropped: v.number(),
      atLeast: v.boolean(),
      live: v.optional(v.object({ proposed: v.number(), open: v.number(), inProgress: v.number() })),
    }),
  ),
  canEdit: v.boolean(),
  canWriteItems: v.optional(v.literal(true)),
  closeReceipt: v.optional(v.string()),
});
type Result = typeof planViewResult.type;
const empty = (canEdit: boolean): Result => ({ rows: '[]', more: false, settled: [], canEdit });

export async function planView(ctx: QueryCtx, projectId: Id<'hostedProjects'>): Promise<Result> {
  ctx = finishReadReader(ctx, 'plan');
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  const canEdit = project.owner === user.subject;
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return empty(canEdit);
  const generationId = recordPartition(generation);
  // Coverage belongs to the shared record partition, not a source generation's alias.
  const partition = generation.recordsGenerationId ? await ctx.db.get(generationId) : generation;
  // Settled compact pages retain positions only, so they cannot enforce Item visibility.
  // Role-less viewers use the existing exact-root fallback until those pages carry that metadata.
  const role = await readProjectRole(ctx, project, user.subject);
  const member = Boolean(role);
  const compact = member && partition?.planRowsVersion === 1;
  // Complete compact rows also prove search coverage. Old projected headers can omit the field,
  // including when compact rows were unavailable. Check those source headers only when needed.
  const headers = partition && partition !== generation ? [generation, partition] : [generation];
  let searchComplete = compact || headers.some(row => row.planningSearchVersion === 2);
  if (member && !searchComplete)
    for (const row of headers)
      if (row.planningSearchVersion === undefined && row._creationTime === undefined) {
        const source = await finishReadSourceDb(ctx).get(row._id);
        if (source?.planningSearchVersion === 2) {
          searchComplete = true;
          break;
        }
      }
  const table = await planningRecordTable(ctx, generationId);
  const rows = (kind: 'issue' | 'initiative', status: string, initiativeId?: string) =>
    compact
      ? ctx.db
          .query('projectWorkDataRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q =>
            q
              .eq('generationId', generationId)
              .eq('collection', PLAN_ROWS)
              .eq('parent', planParent(kind, status, initiativeId)),
          )
      : initiativeId === undefined
        ? ctx.db
            .query(table)
            .withIndex('by_planning_kind_and_status', q =>
              q
                .eq('generationId', generationId)
                .eq('collection', 'planningSearch')
                .eq('planning.kind', kind)
                .eq('planning.status', status),
            )
        : ctx.db
            .query(table)
            .withIndex('by_planning_initiativeId_and_kind_and_status', q =>
              q
                .eq('generationId', generationId)
                .eq('collection', 'planningSearch')
                .eq('planning.initiativeId', initiativeId)
                .eq('planning.kind', kind)
                .eq('planning.status', status),
            );
  const parse = (root: { key: string; position: number; value: string }) => {
    try {
      return planViewRow(JSON.parse(root.value), root.position);
    } catch {
      return null;
    }
  };
  const readRows = async (kind: 'issue' | 'initiative', status: string, limit: number) => {
    if (!compact)
      return (await rows(kind, status).take(limit + 1))
        .map(parse)
        .filter((row): row is PlanRow => row !== null);
    const result: PlanRow[] = [];
    for await (const page of rows(kind, status)) {
      result.push(...decodePlanPage(page.value, page.parent));
      if (result.length > limit) break;
    }
    return result.sort((a, b) => a.position - b.position).slice(0, limit + 1);
  };
  let more = false;
  const initiatives = (
    await Promise.all(
      [...liveStatuses, 'closed', 'abandoned'].map(status =>
        readRows('initiative', status, PLAN_INITIATIVE_LIMIT),
      ),
    )
  ).flat();
  if (initiatives.length > PLAN_INITIATIVE_LIMIT) more = true;
  const loadedInitiatives = initiatives.slice(0, PLAN_INITIATIVE_LIMIT);
  const livePages = await Promise.all(
    liveStatuses.map(async status => {
      const page = await readRows('issue', status, PLAN_LIVE_LIMIT);
      return {
        more: page.length > PLAN_LIVE_LIMIT,
        rows: await markPlanPage(ctx, projectId, status, page.slice(0, PLAN_LIVE_LIMIT)),
      };
    }),
  );
  const liveMore = livePages.some(page => page.more);
  more ||= liveMore;
  const liveItems = livePages.flatMap(page => page.rows);
  const reply = {
    rows: JSON.stringify([...loadedInitiatives, ...liveItems]),
    more,
    ...(member ? { liveMore: liveMore || !searchComplete } : {}),
    canEdit,
    ...(role === 'write' ? { canWriteItems: true as const } : {}),
  };
  const tallies =
    member && searchComplete && loadedInitiatives.length
      ? await coveredInitiativeTallies(ctx.db, generationId)
      : null;
  if (tallies)
    return {
      ...reply,
      settled: loadedInitiatives.map(({ id }) => {
        const counts = tallies.get(id) ?? zeroTally();
        return {
          initiativeId: id,
          done: counts.closed,
          dropped: counts.abandoned,
          atLeast: false,
          live: { proposed: counts.proposed, open: counts.open, inProgress: counts['in-progress'] },
        };
      }),
    };

  const withLiveItems = new Set(liveItems.map(row => row.initiativeId));
  const shown = [
    ...loadedInitiatives.filter(isLive),
    ...loadedInitiatives.filter(initiative => !isLive(initiative) && withLiveItems.has(initiative.id)),
  ];
  // All fallback history shares the transaction. Leave space for one maximum-sized document and
  // the response's visibility work before opening or advancing a range.
  const metrics = shown.length ? await ctx.meta?.getTransactionMetrics?.() : undefined;
  let bytes = (metrics?.bytesRead.remaining ?? Infinity) - 2 * 1024 * 1024;
  let documents = (metrics?.documentsRead.remaining ?? Infinity) - 1;
  let queries = (metrics?.databaseQueries.remaining ?? Infinity) - 1;
  const room = () => bytes > 0 && documents > 0;
  const count = async (id: string, status: 'closed' | 'abandoned') => {
    let n = 0;
    if (!room() || queries <= 0) return { n, partial: true };
    queries--;
    for await (const doc of rows('issue', status, id)) {
      bytes -= getDocumentSize(doc);
      documents--;
      n += compact ? decodePlanPage(doc.value, doc.parent).length : Number(parse(doc) !== null);
      if (n > PLAN_SETTLED_LIMIT || !room()) return { n: Math.min(n, PLAN_SETTLED_LIMIT), partial: true };
    }
    return { n, partial: false };
  };
  const settled: Result['settled'] = [];
  for (const { id } of shown) {
    const done = await count(id, 'closed');
    const dropped = await count(id, 'abandoned');
    settled.push({
      initiativeId: id,
      done: done.n,
      dropped: dropped.n,
      atLeast: (member && !searchComplete) || done.partial || dropped.partial,
    });
  }
  return { ...reply, settled };
}

export const read = query({
  args: { projectId: v.id('hostedProjects'), observeClose: v.optional(v.string()) },
  returns: planViewResult,
  handler: async (ctx, { projectId, observeClose }) => {
    try {
      const view = await planView(ctx, projectId);
      if (!view.canEdit || !observeClose) return view;
      const actor = (await ctx.auth.getUserIdentity())!.subject;
      const operation = await hostedOperationRow(ctx, projectId, actor, observeClose);
      if (operation?.planningApply) return view;
      const terminal =
        operation && hostedOperationSchema.parse(JSON.parse(operation.value)).terminal?.outcome;
      if (terminal?.status !== 'completed') return view;
      const result = terminal.result as {
        kind?: string;
        operationId: string;
        results: unknown;
        detached: number;
      };
      if (result.kind !== 'planning-close' && result.kind !== 'planning-undo-close') return view;
      return {
        ...view,
        closeReceipt: JSON.stringify({
          operationId: result.operationId,
          results: result.results,
          detached: result.detached,
        }),
      };
    } catch (error) {
      return report(error);
    }
  },
});
