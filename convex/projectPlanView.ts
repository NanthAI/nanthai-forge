// SPDX-License-Identifier: Apache-2.0
// The Plan screen's one read (Items d3357f40, b7a0dff1): the Initiatives, every live Item (proposed, planned, in
// progress) and, per live Initiative, how many of its Items are done and dropped. All of it comes from the planning
// search roots through their existing indexes, so no body is hydrated and no new row is written; one subscription per
// view, re-run only by planning writes in the ranges it read. Members see hidden Items with their mark; the public
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

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
/** A planning search root's value as the screen's row: the model fields and counts, never the body. */
export function planViewRow(value: Record<string, unknown>, position: number): PlanRow | null {
  const { id, kind, title, status } = value;
  if (typeof id !== 'string' || (kind !== 'issue' && kind !== 'initiative') || typeof title !== 'string')
    return null;
  const relations = Array.isArray(value.relations) ? (value.relations as PlanRow['relations']) : undefined;
  const doneWhen =
    Array.isArray(value.doneWhen) && value.doneWhen.length === 2
      ? (value.doneWhen as [number, number])
      : undefined;
  return {
    id,
    kind,
    title,
    status: status as PlanRow['status'],
    position,
    ...(typeof value.version === 'number' ? { version: value.version } : {}),
    ...(text(value.initiativeId) ? { initiativeId: text(value.initiativeId) } : {}),
    ...(text(value.parentId) ? { parentId: text(value.parentId) } : {}),
    ...(text(value.order) ? { order: text(value.order) } : {}),
    ...(text(value.type) ? { type: text(value.type) } : {}),
    ...(text(value.owner) ? { owner: text(value.owner) } : {}),
    ...(relations?.length ? { relations } : {}),
    ...(value.hidden === true ? { hidden: true } : {}),
    ...(doneWhen ? { doneWhen } : {}),
  };
}

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
  const table = await planningRecordTable(ctx, generationId);
  const rows = (kind: 'issue' | 'initiative', status: string, initiativeId?: string) =>
    initiativeId === undefined
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
  let more = false;
  const out: PlanRow[] = [];
  const initiatives = (
    await Promise.all(
      [...liveStatuses, 'closed', 'abandoned'].map(status =>
        rows('initiative', status).take(PLAN_INITIATIVE_LIMIT + 1),
      ),
    )
  ).flat();
  if (initiatives.length > PLAN_INITIATIVE_LIMIT) more = true;
  for (const root of initiatives.slice(0, PLAN_INITIATIVE_LIMIT)) {
    const row = parse(root);
    if (row) out.push(row);
  }
  for (const pageRows of await Promise.all(
    liveStatuses.map(status => rows('issue', status).take(PLAN_LIVE_LIMIT + 1)),
  )) {
    if (pageRows.length > PLAN_LIVE_LIMIT) more = true;
    for (const root of pageRows.slice(0, PLAN_LIVE_LIMIT)) {
      const row = parse(root);
      if (row) out.push(row);
    }
  }
  const live = out.filter(
    row => row.kind === 'initiative' && (liveStatuses as readonly string[]).includes(row.status),
  );
  const settled = await Promise.all(
    live.map(async ({ id }) => {
      const [done, dropped] = await Promise.all(
        (['closed', 'abandoned'] as const).map(status =>
          rows('issue', status, id).take(PLAN_SETTLED_LIMIT + 1),
        ),
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
