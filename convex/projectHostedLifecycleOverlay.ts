// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
type Ctx = QueryCtx | MutationCtx;
export const lifecycleGuard = (ctx: Ctx, projectId: Id<'hostedProjects'>, intentId: string) =>
  ctx.db
    .query('projectHostedLifecycleGuards')
    .withIndex('by_project_and_intent', q => q.eq('projectId', projectId).eq('intentId', intentId))
    .unique();
export async function touchLifecycleIntent(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  intentId: string,
) {
  const guard = await lifecycleGuard(ctx, projectId, intentId);
  if (guard) await ctx.db.patch(guard._id, { revision: guard.revision + 1 });
  else
    await ctx.db.insert('projectHostedLifecycleGuards', { projectId, intentId, revision: 1, planId: null });
}
export const lifecyclePointer = (ctx: Ctx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedLifecyclePointers')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
/** A private staged version becomes visible only through its one applied marker. */
export async function visibleLifecycleRecord(ctx: Ctx, projectId: Id<'hostedProjects'>, laneId: string) {
  const pointer = await lifecyclePointer(ctx, projectId, laneId);
  if (!pointer) return null;
  const plan = await ctx.db.get(pointer.planId);
  invariant(
    plan && plan.projectId === projectId,
    'SOURCE_UNAVAILABLE',
    'The retained lifecycle marker is unavailable.',
  );
  if (plan.status !== 'applied') return null;
  const row = await ctx.db.get(pointer.recordId);
  invariant(
    row && row.projectId === projectId && row.kind === 'lane' && row.key === laneId,
    'SOURCE_UNAVAILABLE',
    'The applied lifecycle version is unavailable.',
  );
  return { pointer, row };
}
export async function effectiveLifecycleRecord(ctx: Ctx, row: Doc<'projectHostedRecords'>) {
  if (row.kind !== 'lane') return row;
  const overlay = await visibleLifecycleRecord(ctx, row.projectId, row.key);
  return overlay?.pointer.baseRecordId === row._id ? overlay.row : row;
}
/** Canonical materialization changes neither visible state nor Intent revision.
 * Every later writer first promotes the visible immutable version, preserving
 * version history and the expected-head/lifecycle CAS used by saves and H14. */
export async function materializeLifecycleLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
) {
  const overlay = await visibleLifecycleRecord(ctx, projectId, laneId);
  if (!overlay) return;
  const head = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('key', laneId),
    )
    .unique();
  if (head?.recordId !== overlay.pointer.baseRecordId) return;
  const row = overlay.row;
  await ctx.db.patch(row._id, { lifecyclePlanId: undefined });
  await ctx.db.replace(head._id, {
    projectId,
    kind: 'lane',
    key: laneId,
    parent: row.parent,
    status: row.status,
    version: row.version,
    ...(row.ownerOnly !== undefined ? { ownerOnly: row.ownerOnly } : {}),
    recordId: row._id,
  });
}
