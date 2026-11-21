// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { PlanningItem } from '../src/work-planning-types';
import { workRecordLookup } from './projectWorkRecordTables';

export type InitiativeWorkIdentity = { projectId: Id<'hostedProjects'>; initiativeId: string };
type WorkTotals = NonNullable<Doc<'projectInitiativeWorkMembers'>['summary']>;
type WorkCounts = Pick<WorkTotals, 'landings' | 'files' | 'missing'>;
type PlanRoot = Pick<Doc<'projectPlanningRecords'>, 'value' | 'planning' | 'collection'>;

export const WORK_PATHS_PAGE = 500;
const emptyWorkCounts = () => ({ landings: 0, files: 0, missing: 0 });
export const workCounts = ({ landings, files, missing }: WorkCounts) => ({ landings, files, missing });

export const workMembers = (ctx: QueryCtx, scope: InitiativeWorkIdentity) =>
  ctx.db
    .query('projectInitiativeWorkMembers')
    .withIndex('by_project_and_initiative_and_kind_and_key', q =>
      q.eq('projectId', scope.projectId).eq('initiativeId', scope.initiativeId).lt('kind', 'summary'),
    );

function workMember(
  ctx: QueryCtx,
  scope: InitiativeWorkIdentity,
  kind: 'summary' | 'receipt' | 'path',
  key: string,
) {
  return ctx.db
    .query('projectInitiativeWorkMembers')
    .withIndex('by_project_and_initiative_and_kind_and_key', q =>
      q
        .eq('projectId', scope.projectId)
        .eq('initiativeId', scope.initiativeId)
        .eq('kind', kind)
        .eq('key', key),
    )
    .unique();
}

export async function initiativeWorkSummary(ctx: QueryCtx, scope: InitiativeWorkIdentity) {
  const row = await workMember(ctx, scope, 'summary', '');
  return row?.summary ? { _id: row._id, rebuild: row.rebuild, ...row.summary } : null;
}

export function activeWorkRoot(row: PlanRoot | null, kind: 'initiative' | 'issue') {
  if (row?.collection !== 'planningSearch' || (row.planning && row.planning.kind !== kind)) return null;
  const root = JSON.parse(row.value) as PlanningItem;
  return root.kind === kind && !root.purged && root.status !== 'archived' && root.status !== 'deleted'
    ? root
    : null;
}

export const itemWorkRoot = (ctx: QueryCtx, partition: Id<'projectWorkGenerations'>, id: string) =>
  workRecordLookup(ctx, partition, 'planningSearch', id);

const rebuild = makeFunctionReference<'mutation'>('projectInitiativeWorkRebuild:advance');
const refresh = makeFunctionReference<'mutation'>('projectInitiativeWorkRebuild:refresh');

export const nextWorkInitiative = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, after: string) =>
  ctx.db
    .query('projectInitiativeWorkMembers')
    .withIndex('by_project_and_initiative_and_kind_and_key', q =>
      q.eq('projectId', projectId).gt('initiativeId', after),
    )
    .first();

/** Fresh Work projections may move Items while our project-owned rows survive.
 * Only a project with previously initialized summaries needs reconciliation. */
export async function scheduleWorkRefresh(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
) {
  if (await nextWorkInitiative(ctx, projectId, ''))
    await ctx.scheduler.runAfter(0, refresh, { projectId, partition });
}

export async function createWorkSummary(
  ctx: MutationCtx,
  scope: InitiativeWorkIdentity,
  partition: Id<'projectWorkGenerations'>,
) {
  if (!(await initiativeWorkSummary(ctx, scope)))
    await ctx.db.insert('projectInitiativeWorkMembers', {
      ...scope,
      kind: 'summary',
      key: '',
      summary: { ...emptyWorkCounts(), partition, stale: false },
    });
}

export async function requestWorkRebuild(
  ctx: MutationCtx,
  scope: InitiativeWorkIdentity,
  partition: Id<'projectWorkGenerations'>,
  force = false,
) {
  const summary = await initiativeWorkSummary(ctx, scope);
  if (!force && summary?.partition === partition && summary.rebuild?.phase === 'clear') return;
  const state = { id: crypto.randomUUID(), step: 0, phase: 'clear' as const };
  const fields = { summary: { ...emptyWorkCounts(), partition, stale: true }, rebuild: state };
  if (summary) await ctx.db.patch(summary._id, fields);
  else await ctx.db.insert('projectInitiativeWorkMembers', { ...scope, kind: 'summary', key: '', ...fields });
  await ctx.scheduler.runAfter(0, rebuild, { ...scope, id: state.id, step: state.step });
  return state.id;
}

/** One receipt marker deduplicates a landing across Items. A paged receipt
 * contributes a lower bound for files until its last path is recorded. */
export async function foldWorkReceipt(
  ctx: MutationCtx,
  scope: InitiativeWorkIdentity,
  counts: WorkCounts,
  receiptId: string,
  paths: () => Promise<readonly string[] | null>,
  limit: number,
) {
  const member = await workMember(ctx, scope, 'receipt', receiptId);
  const receipt = member?.kind === 'receipt' ? member : null;
  if (receipt && receipt.nextPath === undefined) return { used: 0, pending: false };
  const files = await paths();
  const start = receipt?.nextPath ?? 0;
  const page = files?.slice(start, start + limit) ?? [];
  const end = start + page.length;
  const pending = files !== null && end < files.length;
  if (!receipt) {
    await ctx.db.insert('projectInitiativeWorkMembers', {
      ...scope,
      kind: 'receipt',
      key: receiptId,
      ...(pending ? { nextPath: end } : {}),
    });
    counts.landings++;
    if (pending || files === null) counts.missing++;
  } else {
    await ctx.db.patch(receipt._id, { nextPath: pending ? end : undefined });
    if (!pending && files !== null) counts.missing--;
  }
  const unique = [...new Set(page)];
  const existing = await Promise.all(unique.map(path => workMember(ctx, scope, 'path', path)));
  for (const [index, key] of unique.entries()) {
    if (existing[index]) continue;
    await ctx.db.insert('projectInitiativeWorkMembers', { ...scope, kind: 'path', key });
    counts.files++;
  }
  return { used: page.length, pending };
}
