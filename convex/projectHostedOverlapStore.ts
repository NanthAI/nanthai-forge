// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
import { mergeOverlapChanges, advanceOverlapMain, type OverlapChange } from '../src/hosted-overlap';
import { trackLineLane } from './projectLiveLineStore';
import { dropLanePark, routeLanePark, trackHostedPresence } from './projectHostedPresence';
import { parkedFor } from '../src/hosted-records';
import { notifyStackDependents, trackStackDependent } from './projectHostedStackNotice';
import { closeConflictNotices, planTrialMerge } from './projectHostedConflicts';
import { appendOverlapMainLog } from './projectHostedOverlapMainLog';
import { addPlanLane, planLaneItem, removePlanLanes } from './projectPlanLaneMarks';
import { recordHead } from './projectHostedRecords';
import { recordFeedEvent } from './projectFeedStore';

export async function trackHostedOverlapLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: z.infer<typeof hostedLaneSchema>,
  metadata?: {
    changes?: OverlapChange[];
    /** The authenticated actor of a save that published a new head. */
    savedBy?: string;
    complete?: boolean;
    baseSequence?: number;
    intent?: string;
    /** The starting agent session's slug (c29d0780); later writes keep the stored one. */
    agent?: string | null;
    holderChanged?: true;
    session?: import('zod').infer<typeof import('../src/hosted-lane').sessionMetadataSchema>;
    /** A sync moved the base to a newer main; the Lane's saved paths still describe its own work. */
    rebased?: boolean;
    /** A save submitted to settle in the background (fea47345 C): its paths count before its head
     * is published, so a first save from the base still records them. */
    pending?: boolean;
  },
  planning?: {
    project: Doc<'hostedProjects'>;
    itemId: string | null | undefined;
    newLane: boolean;
    reopened: boolean;
  },
) {
  const old = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
    .unique();
  const sameBase = old?.baseHead === lane.base.head;
  const keepChanges = sameBase || metadata?.rebased === true;
  const sameHead = old?.head === lane.head;
  const unchangedBase = lane.head === lane.base.head && !metadata?.pending;
  let projection = unchangedBase
    ? { changes: '[]', complete: true }
    : mergeOverlapChanges(
        keepChanges && old ? JSON.parse(old.changes) : [],
        metadata?.changes ?? [],
        (keepChanges && old ? old.complete : false) &&
          (sameHead || metadata?.changes !== undefined) &&
          metadata?.complete !== false,
      );
  // A resolution Lane is the same agent run's work as the Lane it resolves (d730121f): its first row
  // takes the origin's run slug, one indexed read once per resolution Lane.
  const origin =
    !old && lane.resolution?.origin
      ? await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q =>
            q.eq('projectId', projectId).eq('laneId', lane.resolution!.origin!.laneId),
          )
          .unique()
      : null;
  if (origin && !unchangedBase)
    projection = mergeOverlapChanges(
      JSON.parse(origin.changes),
      JSON.parse(projection.changes),
      origin.complete && metadata?.complete !== false,
    );
  // Stack membership (Issue ee9d5738): the root is the parent's own root, read once per (re)stack. A
  // Lane without an attached stack stores nothing and pays no read.
  const stack = lane.stack && !lane.stack.detached ? lane.stack : undefined;
  const parentRow =
    stack && !(old?.stackRoot && old.stackParent === stack.laneId)
      ? await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', stack.laneId))
          .unique()
      : null;
  const stackRoot = stack
    ? parentRow
      ? (parentRow.stackRoot ?? stack.laneId)
      : (old?.stackRoot ?? stack.laneId)
    : undefined;
  const agent =
    metadata?.agent === null
      ? undefined
      : (metadata?.agent ?? old?.agent ?? (origin?.actor === lane.actor ? origin.agent : undefined));
  const savedBy = metadata?.savedBy === lane.actor ? (true as const) : (metadata?.savedBy ?? old?.savedBy);
  const open = ['active', 'paused', 'ready'].includes(lane.state);
  // Superseded lasts while the Lane stays open at the head it was set on; a save or reopen ends it.
  const superseded = old?.open && open && old.superseded?.laneHead === lane.head ? old.superseded : undefined;
  const itemId =
    old?.planningItemId ??
    planning?.itemId ??
    (origin?.intentId === lane.intentId ? origin.planningItemId : undefined);
  let planningItemId = itemId ?? undefined;
  let planLaneMark = old?.planLaneMark;
  if (!open && planLaneMark) {
    await removePlanLanes(ctx, planLaneMark, [old?.lifecyclePlanId]);
    planLaneMark = undefined;
  } else if (
    !planLaneMark &&
    open &&
    planning?.project.work?.generationId &&
    itemId !== null &&
    (planning.newLane || planning.reopened || (planningItemId && !sameHead))
  ) {
    if (!planningItemId) {
      const intent = await recordHead(ctx, projectId, 'intent', lane.intentId);
      planningItemId = intent?.planningItemId ?? lane.intentId;
    }
    const item = await planLaneItem(ctx, planning.project, planningItemId);
    if (item) planLaneMark = await addPlanLane(ctx, projectId, item);
    else planningItemId = undefined;
  }
  const value = {
    projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    actor: lane.actor,
    ...(lane.holder ? { holderActor: lane.holder.actor } : {}),
    ...(savedBy ? { savedBy } : {}),
    ...(lane.holder?.sessionId
      ? {
          session: metadata?.session ??
            (!metadata?.holderChanged ? old?.session : undefined) ?? {
              sessionId: lane.holder.sessionId,
              startedAt: lane.holder.since,
            },
        }
      : {}),
    ...(agent ? { agent } : {}),
    intent: (metadata?.intent ?? old?.intent ?? lane.intentId).slice(0, 160),
    head: lane.head,
    baseHead: lane.base.head,
    ...(lane.resolution ? { resolutionLeft: lane.resolution.left } : {}),
    ...(lane.resolution?.origin ? { resolutionOrigin: lane.resolution.origin.laneId } : {}),
    ...(stack && stackRoot ? { stackRoot, stackParent: stack.laneId } : {}),
    baseReceiptId: lane.base.receiptId,
    baseSequence: metadata?.baseSequence ?? (sameBase ? (old?.baseSequence ?? null) : null),
    recordVersion: lane.version,
    open,
    ...(planningItemId ? { planningItemId } : {}),
    ...(planLaneMark
      ? {
          planLaneMark,
          planLanePin: { sourceVersion: lane.sourceVersion, lifecycleVersion: lane.lifecycleVersion },
        }
      : {}),
    // An unchanged pending save must not erase a staged lifecycle association.
    ...(old?.lifecyclePlanId && !planning ? { lifecyclePlanId: old.lifecyclePlanId } : {}),
    ...(superseded ? { superseded } : {}),
    lastActivityAt: Number.isFinite(Date.parse(lane.at)) ? Date.parse(lane.at) : Date.now(),
    // Landing evidence belongs to the head that landed and survives later records of the Lane.
    ...(old?.landed ? { landed: old.landed } : {}),
    // Another Lane is stacked on this one (Issue dc62b120); only a stacked start sets it.
    ...(old?.stacked ? { stacked: true as const } : {}),
    // Open exact-conflict notices (flip 4) are ended by closeConflictNotices, never by a record write.
    ...(old?.conflicted ? { conflicted: true as const } : {}),
    // Parked (Item e1633718): only an open Lane is parked; closing it ends the park with its presence row.
    ...(open && lane.park ? { park: lane.park } : {}),
    ...projection,
  };
  const at = Date.parse(lane.at);
  const presenceRow = await trackHostedPresence(
    ctx,
    projectId,
    lane.id,
    old
      ? {
          ...old,
          actor: metadata?.holderChanged
            ? (lane.holder?.change?.previous?.actor ?? old.actor)
            : (lane.holder?.actor ?? old.actor),
          pointer: old.presenceRow,
          goal: old.intent,
        }
      : null,
    value.open && !superseded
      ? {
          intentId: value.intentId,
          actor: lane.holder?.actor ?? value.actor,
          ...(value.session ? { session: value.session } : {}),
          ...(value.agent ? { agent: value.agent } : {}),
          goal: value.intent,
          changes: value.changes,
          at: Number.isFinite(at) ? at : Date.now(),
          ...(value.park ? { park: value.park } : {}),
        }
      : null,
  );
  // Parked Lanes (Item e1633718) route to the named holder's account, or the starter's: a routing row exists only
  // while an open Lane is parked, written only when that account changes.
  await routeLanePark(
    ctx,
    projectId,
    lane.id,
    old?.presenceRow && old.park ? parkedFor(old.park, lane.actor) : undefined,
    presenceRow && value.park ? parkedFor(value.park, lane.actor) : undefined,
  );
  const stored = { ...value, ...(presenceRow ? { presenceRow } : {}) };
  const sourceId = old ? old._id : await ctx.db.insert('projectHostedOverlapLanes', stored);
  if (old) await ctx.db.replace(old._id, stored);
  await trackLineLane(ctx, sourceId, stored, old, false);
  const feedLane = { projectId, laneId: lane.id, actor: lane.holder?.actor ?? lane.actor };
  if (old && !sameHead)
    await recordFeedEvent(ctx, { ...feedLane, kind: 'lane.saved', sourceVersion: lane.sourceVersion });
  if (old?.open && !open && (old.landed?.laneHead !== lane.head || lane.state === 'abandoned'))
    await recordFeedEvent(ctx, { ...feedLane, kind: 'lane.closed', recordVersion: lane.version });
  // Exact conflicts at save (flip 4): a moved head of an open Lane plans a trial merge; a Lane that
  // lands or is abandoned ends the notices on both sides.
  if (old?.open && !open && old.conflicted)
    await closeConflictNotices(ctx, projectId, lane.id, lane.state === 'abandoned' ? 'abandoned' : 'landed');
  else if (old && open && old.head !== lane.head)
    await planTrialMerge(
      ctx,
      projectId,
      { ...stored, _id: old._id, _creationTime: old._creationTime },
      old.head,
    );
  // Stacked Lanes (Issue dc62b120). A Lane nobody stacked on has no flag and a Lane without `stack`
  // returns at once, so neither adds a read. This Lane as a child: keep its dependents row. As a parent:
  // one notice per dependent when its saved head moved or it was abandoned.
  await trackStackDependent(ctx, projectId, lane, open);
  if (old?.stacked) {
    const parent = { projectId, laneId: lane.id, actor: lane.actor, ...(agent ? { agent } : {}) };
    if (open && lane.head !== old.head)
      await notifyStackDependents(ctx, parent, { kind: 'saved', head: lane.head });
    else if (old.open && !open && lane.state === 'abandoned')
      await notifyStackDependents(ctx, parent, { kind: 'abandoned', key: String(lane.version) });
  }
}

export async function trackHostedOverlapMain(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  sequence: number,
  paths: string[] | null,
) {
  const old = await ctx.db
    .query('projectHostedOverlapMain')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  // A replayed publication finds the row already at this sequence: nothing moves, nothing is logged twice.
  if (old?.sequence === sequence) return;
  const value = { projectId, ...advanceOverlapMain(old, sequence, paths) };
  if (old) await ctx.db.replace(old._id, value);
  else await ctx.db.insert('projectHostedOverlapMain', value);
  await appendOverlapMainLog(ctx, projectId, old ? old.sequence : sequence - 1, sequence, paths);
}

/** Staged cascade visibility follows its existing atomic applied marker. */
export async function markHostedOverlapLifecycle(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  lifecyclePlanId: Id<'projectHostedLifecyclePlans'>,
) {
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  // A staged close hides the Lane from presence now; a later record write of a still-open Lane restores it.
  if (row?.presenceRow) await ctx.db.delete(row.presenceRow.id);
  // A parked Lane (Item e1633718) leaves its holder's Needs me with its presence row.
  if (row) await dropLanePark(ctx, row);
  if (row) await ctx.db.patch(row._id, { lifecyclePlanId, presenceRow: undefined });
  if (row?.open && row.conflicted) await closeConflictNotices(ctx, projectId, laneId, 'abandoned');
  // The only staged close is an abandonment by an Intent cascade: Lanes stacked on this one are told.
  if (row?.stacked && row.open)
    await notifyStackDependents(
      ctx,
      { projectId, laneId, actor: row.actor, ...(row.agent ? { agent: row.agent } : {}) },
      { kind: 'abandoned', key: String(lifecyclePlanId) },
    );
  return row?.planLaneMark;
}

/** Retire the advisory open entry when its existing lifecycle overlay is promoted. */
export async function materializeHostedOverlapLifecycle(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  recordVersion: number,
) {
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (row?.presenceRow) await ctx.db.delete(row.presenceRow.id);
  if (row) await dropLanePark(ctx, row);
  if (row)
    await ctx.db.patch(row._id, {
      open: false,
      recordVersion,
      lifecyclePlanId: undefined,
      planLaneMark: undefined,
      planLanePin: undefined,
      presenceRow: undefined,
    });
  if (row?.open)
    await recordFeedEvent(ctx, {
      projectId,
      laneId,
      actor: row.holderActor ?? row.actor,
      kind: 'lane.closed',
      recordVersion,
    });
}
