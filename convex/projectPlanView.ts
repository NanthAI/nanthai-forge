// SPDX-License-Identifier: Apache-2.0
// The Plan screen's one read (Items d3357f40, b7a0dff1): the Initiatives, every live Item (proposed, planned, in
// progress) and settled counts for each live Initiative or settled Initiative with live Items. It uses compact
// planning pages once the partition is covered and indexed search roots otherwise. It never hydrates bodies or
// writes. One subscription reruns on writes in its ranges. Members see hidden Items with their mark.
import { getDocumentSize, v } from 'convex/values';
import { planQuery as query } from './cliServer';
import { finishReadReader } from './projectFinishReadReader';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { report } from './errors';
import { invariant } from '../src/errors';
import { isLive, type PlanRow } from '../src/planning-model';
export { planViewRow } from './projectPlanRows';
import { markPlanPage } from './projectPlanLaneMarks';
import { decodePlanPage, PLAN_ROWS, planParent, planViewRow } from './projectPlanRows';

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
  /** Done and dropped Items per live Initiative or settled Initiative with live Items. */
  settled: v.array(
    v.object({ initiativeId: v.string(), done: v.number(), dropped: v.number(), atLeast: v.boolean() }),
  ),
  canEdit: v.boolean(),
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
  const compact = partition?.planRowsVersion === 1 && !!(await readProjectRole(ctx, project, user.subject));
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
  const readRows = async (
    kind: 'issue' | 'initiative',
    status: string,
    limit: number,
    initiativeId?: string,
  ) => {
    if (!compact)
      return (await rows(kind, status, initiativeId).take(limit + 1))
        .map(parse)
        .filter((row): row is PlanRow => row !== null);
    const result: PlanRow[] = [];
    for await (const page of rows(kind, status, initiativeId)) {
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
  more ||= livePages.some(page => page.more);
  const liveItems = livePages.flatMap(page => page.rows);
  const withLiveItems = new Set(liveItems.map(row => row.initiativeId));
  const tally = (initiativeId: string, done: number, dropped: number, partial = false) => ({
    initiativeId,
    done: Math.min(done, PLAN_SETTLED_LIMIT),
    dropped: Math.min(dropped, PLAN_SETTLED_LIMIT),
    atLeast: partial || done > PLAN_SETTLED_LIMIT || dropped > PLAN_SETTLED_LIMIT,
  });
  const settled = await Promise.all(
    loadedInitiatives.filter(isLive).map(async ({ id }) => {
      const [done, dropped] = await Promise.all([
        readRows('issue', 'closed', PLAN_SETTLED_LIMIT, id),
        readRows('issue', 'abandoned', PLAN_SETTLED_LIMIT, id),
      ]);
      return tally(id, done.length, dropped.length);
    }),
  );
  const extra = loadedInitiatives.filter(
    initiative => !isLive(initiative) && withLiveItems.has(initiative.id),
  );
  if (extra.length) {
    // Supplemental history shares the existing transaction. Leave space for one maximum-sized
    // document and for the response's visibility work before opening or advancing another range.
    const metrics = await ctx.meta?.getTransactionMetrics?.();
    const MiB = 1024 * 1024;
    let bytes = (metrics?.bytesRead.remaining ?? Infinity) - 2 * MiB;
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
        if (n > PLAN_SETTLED_LIMIT || !room()) return { n, partial: true };
      }
      return { n, partial: false };
    };
    for (const { id } of extra) {
      const done = await count(id, 'closed');
      const dropped = await count(id, 'abandoned');
      settled.push(tally(id, done.n, dropped.n, done.partial || dropped.partial));
    }
  }
  return { rows: JSON.stringify([...loadedInitiatives, ...liveItems]), more, settled, canEdit };
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: planViewResult,
  handler: async (ctx, { projectId }) => {
    try {
      return await planView(ctx, projectId);
    } catch (error) {
      return report(error);
    }
  },
});
