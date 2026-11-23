// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
import { mergeOverlapChanges, advanceOverlapMain, type OverlapChange } from '../src/hosted-overlap';
import { presencePaths } from '../src/hosted-presence';
import {
  hasSymbolFacts,
  joinOverlapBuckets,
  overlapBucketRows,
  overlapBucketsOn,
  overlapLaneChanges,
  writeOverlapBuckets,
} from './projectHostedOverlapChanges';
import { trackLineLane } from './projectLiveLineStore';
import {
  dropLanePark,
  releaseLaneSession,
  routeLanePark,
  trackHostedPresence,
} from './projectHostedPresence';
import { parkedFor } from '../src/hosted-records';
import { notifyStackDependents, trackStackDependent } from './projectHostedStackNotice';
import { closeConflictNotices, closeLeftConflicts, planTrialMerge } from './projectHostedConflicts';
import { appendOverlapMainLog } from './projectHostedOverlapMainLog';
import { addPlanLane, planLaneItem, removePlanLanes } from './projectPlanLaneMarks';
import { recordHead } from './projectHostedRecords';
import { recordFeedEvent } from './projectFeedStore';

/** Loose ends details (Item fc1831eb), computed from the row this write already read. `saves` counts moved heads (the
 * same event as the feed's lane.saved) from the first write that sees the field, so a Lane written before it keeps
 * "not recorded" until the one-time backfill sets a count. `passedAt` belongs to one head: any other head, and a
 * closed Lane, drop it. */
function looseEndDetails(
  old: Doc<'projectHostedOverlapLanes'> | null,
  lane: z.infer<typeof hostedLaneSchema>,
  sameHead: boolean,
  unchangedBase: boolean,
) {
  const saves = old
    ? old.saves === undefined
      ? undefined
      : old.saves + (sameHead ? 0 : 1)
    : unchangedBase
      ? 0
      : 1;
  const open = ['active', 'paused', 'ready'].includes(lane.state);
  return {
    ...(saves === undefined ? {} : { saves }),
    ...(old?.passedAt !== undefined && sameHead && open
      ? { passedAt: old.passedAt, ...(old.passedMark ? { passedMark: old.passedMark } : {}) }
      : {}),
  };
}

type OverlapRow = Doc<'projectHostedOverlapLanes'>;
/** The saved head's evidence: pending entries swapped back for what the saved head held. `current` is the row's list. */
function settledEvidence(row: OverlapRow, current: string) {
  const touched = new Set(row.settled!.paths);
  const kept = (JSON.parse(current) as OverlapChange[]).filter(change => !touched.has(change.path));
  return {
    changes: [...kept, ...(JSON.parse(row.settled!.changes) as OverlapChange[])].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    complete: row.settled!.complete,
  };
}
/** Records the saved evidence of the paths a pending delta touches, once per path. */
function addSettled(row: OverlapRow, current: string, delta: OverlapChange[]) {
  const settled = row.settled ?? { paths: [], changes: '[]', complete: row.complete };
  const known = new Set(settled.paths);
  const added = delta.map(change => change.path).filter(path => !known.has(path));
  if (!added.length) return settled;
  const saved = new Map((JSON.parse(current) as OverlapChange[]).map(change => [change.path, change]));
  return {
    paths: [...settled.paths, ...added],
    changes: JSON.stringify([
      ...(JSON.parse(settled.changes) as OverlapChange[]),
      ...added.flatMap(path => (saved.has(path) ? [saved.get(path)!] : [])),
    ]),
    complete: settled.complete,
  };
}

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
    /** A background save at this head failed (Item 3f70760d): rebuild from the saved evidence plus the
     * deltas of the saves still settling at this head, and trial-merge again. */
    restorePending?: { changes: OverlapChange[]; complete: boolean }[];
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
  const bucketsOn = overlapBucketsOn();
  // The list this row held before the write: inline, or joined from its buckets. Read at most once, and only
  // when the projection can change (a slim row's bucket rows are not read for a write that keeps its list).
  let oldBuckets: ReturnType<typeof overlapBucketRows> | undefined;
  const oldBucketRows = () => (oldBuckets ??= overlapBucketRows(ctx, projectId, lane.id));
  let oldText: string | undefined;
  const oldList = async () =>
    (oldText ??= old!.changes ?? joinOverlapBuckets((await oldBucketRows()).map(bucket => bucket.changes)));
  // A write of a slim row that keeps its saved list as it is (same head and base, nothing new, nothing failed):
  // `boundOverlapChanges` on its own output returns it unchanged (tests/hosted-overlap-buckets.test.mjs), so no
  // bucket is read or written, and the row keeps its list summary.
  const keepsList =
    bucketsOn &&
    old !== null &&
    old.changes === undefined &&
    old.pathSummary !== undefined &&
    sameHead &&
    metadata?.changes === undefined &&
    !metadata?.restorePending &&
    (unchangedBase
      ? old.pathSummary.pathCount === 0 && old.complete
      : keepChanges && metadata?.complete !== false);
  // Pending deltas never outlive their head: a head move (that save's publish, or any other) and a
  // failed save start from the saved evidence (Item 3f70760d, review of receipt 4401958d).
  const saved =
    keepsList || unchangedBase || !(keepChanges && old)
      ? { changes: [], complete: false }
      : old.settled && (!sameHead || metadata?.restorePending)
        ? settledEvidence(old, await oldList())
        : { changes: JSON.parse(await oldList()) as OverlapChange[], complete: old.complete };
  let projection: { changes: string | undefined; complete: boolean } = keepsList
    ? { changes: undefined, complete: old.complete }
    : unchangedBase
      ? { changes: '[]', complete: true }
      : mergeOverlapChanges(
          saved.changes,
          metadata?.changes ?? [],
          saved.complete && (sameHead || metadata?.changes !== undefined) && metadata?.complete !== false,
        );
  for (const other of unchangedBase ? [] : (metadata?.restorePending ?? []))
    projection = mergeOverlapChanges(
      JSON.parse(projection.changes!),
      other.changes,
      projection.complete && other.complete,
    );
  // What `changes` held at the saved head for every path a still-settling save touched.
  const settled =
    ['active', 'paused', 'ready'].includes(lane.state) && keepChanges && sameHead && old && !unchangedBase
      ? metadata?.pending
        ? addSettled(old, await oldList(), metadata.changes ?? [])
        : metadata?.restorePending
          ? metadata.restorePending.length
            ? old.settled
            : undefined
          : old.settled
      : undefined;
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
      JSON.parse(await overlapLaneChanges(ctx, origin)),
      JSON.parse(projection.changes!),
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
    ...(old?.saveFailure ? { saveFailure: old.saveFailure } : {}),
    ...(settled ? { settled } : {}),
    // Parked (Item e1633718): only an open Lane is parked; closing it ends the park with its presence row.
    ...(open && lane.park ? { park: lane.park } : {}),
    ...looseEndDetails(old, lane, sameHead, unchangedBase),
    ...(open && !superseded && old?.landed ? { landedMark: true as const } : {}),
    complete: projection.complete,
  };
  // The list itself: inline (switch off), or buckets and a slim row (switch on). Presence compares the paths summary.
  const list = projection.changes;
  const summary = list === undefined ? old!.pathSummary! : presencePaths(list);
  const slim =
    list === undefined
      ? { pathSummary: summary, ...(old!.symbolFacts ? { symbolFacts: true as const } : {}) }
      : bucketsOn
        ? { pathSummary: summary, ...(hasSymbolFacts(list) ? { symbolFacts: true as const } : {}) }
        : { changes: list };
  if (list !== undefined) {
    if (bucketsOn) await writeOverlapBuckets(ctx, projectId, lane.id, list, await oldBucketRows());
    else if (old && old.changes === undefined)
      for (const row of await oldBucketRows()) await ctx.db.delete(row._id);
  }
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
          paths: old.pathSummary ?? presencePaths(old.changes!),
          goal: old.intent,
          ...(old.landedMark ? { landedBefore: true as const } : {}),
        }
      : null,
    value.open && !superseded
      ? {
          intentId: value.intentId,
          actor: lane.holder?.actor ?? value.actor,
          ...(value.session ? { session: value.session } : {}),
          ...(value.agent ? { agent: value.agent } : {}),
          goal: value.intent,
          paths: summary,
          at: Number.isFinite(at) ? at : Date.now(),
          ...(value.park ? { park: value.park } : {}),
          ...(value.saves === undefined ? {} : { saves: value.saves }),
          ...(value.landed ? { landedBefore: true as const } : {}),
          ...(value.passedAt === undefined ? {} : { passedAt: value.passedAt }),
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
  // A stamp that did not carry over (a newer head, or a closed Lane) takes its marker row with it.
  if (old?.passedMark && value.passedMark !== old.passedMark) await ctx.db.delete(old.passedMark);
  const stored = { ...value, ...slim, ...(presenceRow ? { presenceRow } : {}) };
  // The in-memory row the trial merge reads carries the list even when the stored one is slim.
  const withList = (row: Doc<'projectHostedOverlapLanes'>) =>
    list === undefined ? row : { ...row, changes: list };
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
  else if (old && open && metadata?.restorePending)
    // A failed background save: notices its pending paths ended are decided again from the saved head.
    await planTrialMerge(
      ctx,
      projectId,
      withList({ ...stored, _id: old._id, _creationTime: old._creationTime }),
      undefined,
    );
  else if (
    old?.conflicted &&
    open &&
    old.head === lane.head &&
    metadata?.changes !== undefined &&
    stored.complete
  )
    // Paths changed at the same head (a background save before its head publishes): notices on files
    // the Lane no longer changes end now, not on a later read (Item 3f70760d). A bounded (incomplete)
    // path list proves nothing, so it ends none.
    await closeLeftConflicts(
      ctx,
      projectId,
      lane.id,
      new Set((JSON.parse(list!) as OverlapChange[]).map(change => change.path)),
    );
  else if (old && open && old.head !== lane.head)
    await planTrialMerge(
      ctx,
      projectId,
      withList({ ...stored, _id: old._id, _creationTime: old._creationTime }),
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
  if (row?.presenceRow) {
    await ctx.db.delete(row.presenceRow.id);
    await releaseLaneSession(ctx, projectId, laneId);
  }
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
  if (row?.presenceRow) {
    await ctx.db.delete(row.presenceRow.id);
    await releaseLaneSession(ctx, projectId, laneId);
  }
  if (row) await dropLanePark(ctx, row);
  if (row?.passedMark) await ctx.db.delete(row.passedMark);
  if (row)
    await ctx.db.patch(row._id, {
      open: false,
      passedAt: undefined,
      passedMark: undefined,
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
