// SPDX-License-Identifier: Apache-2.0
// The Plan screen's one read (Items d3357f40, b7a0dff1): the Initiatives, every live Item (proposed, planned, in
// progress) and, per live Initiative, how many of its Items are done and dropped. All of it comes from the planning
// compact pages once their generation is covered, with indexed search roots as the legacy fallback. The query
// never hydrates bodies or writes; one subscription per view re-runs on writes in its ranges. Members see hidden Items with their mark; the public
// plan is read elsewhere through publicPlanVisible (src/planning-model.ts).
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { report } from './errors';
import { invariant } from '../src/errors';
import type { PlanRow } from '../src/planning-model';
export { planViewRow } from './projectPlanRows';
import { decodePlanPage, PLAN_ROWS, planParent, planViewRow } from './projectPlanRows';

/** Live Items read per status, Initiatives read, and settled Items counted per live Initiative; beyond these the
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
  /** Done and dropped Items per live Initiative. */
  settled: v.array(
    v.object({ initiativeId: v.string(), done: v.number(), dropped: v.number(), atLeast: v.boolean() }),
  ),
  canEdit: v.boolean(),
});
type Result = typeof planViewResult.type;
const empty = (canEdit: boolean): Result => ({ rows: '[]', more: false, settled: [], canEdit });

export async function planView(ctx: QueryCtx, projectId: Id<'hostedProjects'>): Promise<Result> {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  const canEdit = project.owner === user.subject;
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return empty(canEdit);
  const generationId = recordPartition(generation);
  // Coverage belongs to the shared record partition, not a source generation's alias.
  const partition = generation.recordsGenerationId ? await ctx.db.get(generationId) : generation;
  const compact = partition?.planRowsVersion === 1;
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
  const out: PlanRow[] = [];
  const initiatives = (
    await Promise.all(
      [...liveStatuses, 'closed', 'abandoned'].map(status =>
        readRows('initiative', status, PLAN_INITIATIVE_LIMIT),
      ),
    )
  ).flat();
  if (initiatives.length > PLAN_INITIATIVE_LIMIT) more = true;
  for (const root of initiatives.slice(0, PLAN_INITIATIVE_LIMIT)) {
    out.push(root);
  }
  for (const pageRows of await Promise.all(
    liveStatuses.map(status => readRows('issue', status, PLAN_LIVE_LIMIT)),
  )) {
    if (pageRows.length > PLAN_LIVE_LIMIT) more = true;
    for (const root of pageRows.slice(0, PLAN_LIVE_LIMIT)) {
      out.push(root);
    }
  }
  const live = out.filter(
    row => row.kind === 'initiative' && (liveStatuses as readonly string[]).includes(row.status),
  );
  const settled = await Promise.all(
    live.map(async ({ id }) => {
      const [done, dropped] = await Promise.all(
        (['closed', 'abandoned'] as const).map(status => readRows('issue', status, PLAN_SETTLED_LIMIT, id)),
      );
      return {
        initiativeId: id,
        done: Math.min(done!.length, PLAN_SETTLED_LIMIT),
        dropped: Math.min(dropped!.length, PLAN_SETTLED_LIMIT),
        atLeast: done!.length > PLAN_SETTLED_LIMIT || dropped!.length > PLAN_SETTLED_LIMIT,
      };
    }),
  );
  return { rows: JSON.stringify(out), more, settled, canEdit };
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
