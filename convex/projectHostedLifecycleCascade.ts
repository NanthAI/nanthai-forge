// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { materializeLifecycleLane, lifecyclePointer } from './projectHostedLifecycleOverlay';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedRecordIndex, hostedRecordRef } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { loadSave, sameSaveLane } from './projectHostedSaveStore';
import { saveResultSchema } from '../src/hosted-save';
import { hostedLifecycleRequestSchema } from '../src/hosted-lifecycle';
import {
  lifecycleCurrent,
  lifecycleResult,
  settleLifecycle,
  applyLifecycleRecord,
  writeLifecycleEvent,
  type LifecyclePlan,
} from './projectHostedLifecycleStore';
export const scheduleLifecycle = (ctx: MutationCtx, planId: Id<'projectHostedLifecyclePlans'>) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLifecycle:advanceInternal'), {
    planId,
  });
/** No client-supplied child list can omit a sibling. Pages read the authoritative
 * parent index; the Intent guard validates the full set without final fan-in. */
export async function advanceLifecycle(ctx: MutationCtx, plan: LifecyclePlan) {
  if (plan.status !== 'pending') return lifecycleResult(plan);
  if (plan.saveOperationId) return advanceSavedLifecycle(ctx, plan);
  const { guard, current, valid } = await lifecycleCurrent(ctx, plan);
  if (!valid) return settleLifecycle(ctx, plan, 'stale');
  if (plan.ready) {
    await applyLifecycleRecord(ctx, plan, current.record);
    await ctx.db.patch(guard!._id, { revision: guard!.revision + 1 });
    const result = await settleLifecycle(ctx, plan, 'applied');
    if (plan.staged) await scheduleLifecycle(ctx, plan._id);
    else await ctx.db.patch(plan._id, { materialized: true });
    return result;
  }
  const page = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', plan.projectId).eq('kind', 'lane').eq('parent', plan.intentId),
    )
    .paginate({ cursor: plan.cursor, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 128 * 1024 });
  let staged = plan.staged;
  for (const head of page.page) {
    await materializeLifecycleLane(ctx, plan.projectId, head.key);
    const row = await readHostedRecord(ctx, {
      projectId: plan.projectId,
      actor: plan.actor,
      kind: 'lane',
      key: head.key,
    });
    invariant(row, 'SOURCE_UNAVAILABLE', 'A selected child Lane is unavailable.');
    const lane = hostedLaneSchema.parse(JSON.parse(row.value));
    if (lane.state !== 'active') continue;
    const record = {
      ...lane,
      version: lane.version + 1,
      lifecycleVersion: lane.lifecycleVersion + 1,
      state: 'abandoned' as const,
      at: plan.at,
    };
    const ref = hostedRecordRef(record),
      value = canonicalPayload(record);
    const bodyId = await ctx.db.insert('projectHostedRecordBodies', { projectId: plan.projectId, value });
    const recordId = await ctx.db.insert('projectHostedRecords', {
      projectId: plan.projectId,
      kind: 'lane',
      key: lane.id,
      ...hostedRecordIndex(record),
      version: record.version,
      bodyId,
      ...(row.ownerOnly !== undefined ? { ownerOnly: row.ownerOnly } : {}),
      digest: ref.digest,
      bytes: ref.bytes,
      lifecyclePlanId: plan._id,
    });
    const pointer = await lifecyclePointer(ctx, plan.projectId, lane.id);
    const next = {
      projectId: plan.projectId,
      laneId: lane.id,
      planId: plan._id,
      baseRecordId: row._id,
      recordId,
    };
    if (pointer) await ctx.db.replace(pointer._id, next);
    else await ctx.db.insert('projectHostedLifecyclePointers', next);
    await writeLifecycleEvent(ctx, plan, lane, staged++);
  }
  await ctx.db.patch(plan._id, { staged, cursor: page.continueCursor, ready: page.isDone });
  await scheduleLifecycle(ctx, plan._id);
  return lifecycleResult({ ...plan, staged, cursor: page.continueCursor, ready: page.isDone });
}
/** Optional index projection. The applied marker already makes all children
 * visible together, including before any tick or after a stopped scheduler. */
export async function materializeLifecycle(ctx: MutationCtx, plan: LifecyclePlan) {
  if (plan.status !== 'applied' || plan.materialized) return lifecycleResult(plan);
  await hostedWriteProject(ctx, plan.projectId, plan.actor, plan.authorityEpoch);
  const page = await ctx.db
    .query('projectHostedLifecycleEvents')
    .withIndex('by_plan_and_index', q => q.eq('planId', plan._id))
    .paginate({
      cursor: plan.materializeCursor,
      numItems: 20,
      maximumRowsRead: 20,
      maximumBytesRead: 128 * 1024,
    });
  for (const event of page.page)
    if (event.kind === 'lane') await materializeLifecycleLane(ctx, plan.projectId, event.key);
  // Keep the provider cursor opaque; appliedThrough is an event count only.
  await ctx.db.patch(plan._id, {
    materialized: page.isDone,
    appliedThrough: plan.appliedThrough + page.page.length,
    materializeCursor: page.continueCursor,
  });
  if (!page.isDone) await scheduleLifecycle(ctx, plan._id);
  return lifecycleResult(plan);
}

async function advanceSavedLifecycle(ctx: MutationCtx, plan: LifecyclePlan) {
  await hostedWriteProject(ctx, plan.projectId, plan.actor, plan.authorityEpoch);
  const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
  invariant(request.target.kind === 'lane', 'BAD_ARGUMENT', 'Save-first selects one Lane.');
  const child = await loadSave(
    ctx,
    { projectId: plan.projectId, actor: plan.actor, operationId: plan.saveOperationId! },
    false,
  );
  const terminal = child.operation.terminal;
  if (!terminal) return lifecycleResult(plan);
  if (terminal.outcome.status === 'failed')
    return settleLifecycle(ctx, plan, 'failed', terminal.outcome.error);
  const saved = saveResultSchema.parse(terminal.outcome.result),
    target = request.target;
  const expected = {
    head: saved.head,
    version: saved.version,
    sourceVersion: saved.sourceVersion,
    lifecycleVersion: target.expected.lifecycleVersion,
  };
  const row = await readHostedRecord(ctx, {
    projectId: plan.projectId,
    actor: plan.actor,
    kind: 'lane',
    key: target.laneId,
  });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The saved Lane is unavailable.');
  const lane = hostedLaneSchema.parse(JSON.parse(row.value));
  if (!sameSaveLane(lane, expected)) return settleLifecycle(ctx, plan, 'stale');
  const next = { ...plan, savedExpected: canonicalPayload(expected), materialized: true };
  await ctx.db.patch(plan._id, { savedExpected: next.savedExpected, materialized: true });
  await applyLifecycleRecord(ctx, next, lane);
  return settleLifecycle(ctx, next, 'applied');
}
/** The child receipt and its wake commit together. Only parents of this exact
 * operation are considered; no idle observer is installed. */
export async function wakeLifecycleSave(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; operationId: string },
) {
  const rows = await ctx.db
    .query('projectHostedLifecyclePlans')
    .withIndex('by_project_and_actor_and_save', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('saveOperationId', input.operationId),
    )
    .take(1);
  if (rows.length)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLifecycle:saveWake'), {
      projectId: input.projectId,
      actor: input.actor,
      saveOperationId: input.operationId,
      cursor: null,
    });
}
