// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { lineOwner, detachLineOwner } from './projectLiveLineOwners';
import { internal } from './_generated/api';
import { nextActivityHour } from './accountProjectOrderHour';

type Db = MutationCtx['db'];
type Mark = Doc<'projectLiveLineLanes'>;
type Stage = Mark['stage'];
const ownerKind = 'projectLiveLineOwner';
const summaryKind = 'projectLiveLineSummary';
export const lineSummary = (db: Pick<Db, 'query'>, projectId: Id<'hostedProjects'>) =>
  db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', summaryKind).eq('sourceId', projectId))
    .unique();
/** Only an explicit removal updates the small latest-exit snapshot. */
export async function lineExit(
  db: Db,
  projectId: Id<'hostedProjects'>,
  exit: { laneId: string; kind: 'landed' | 'set-aside'; at: number },
) {
  const old = await lineSummary(db, projectId);
  const value = old ? JSON.parse(old.value) : {};
  // Last removal only, never a history/replay. Missing events never imply an exit kind.
  value.exit = exit;
  const next = { kind: summaryKind, sourceId: String(projectId), projectId, value: JSON.stringify(value) };
  if (old) await db.replace(old._id, next);
  else await db.insert('projectFinishReadRows', next);
}
export async function removeLineMark(db: Db, old: Mark, kind: 'landed' | 'set-aside') {
  await db.delete(old._id);
  const owner = await lineOwner(db, old.laneId);
  await detachLineOwner(db, owner);
  if (owner) await db.delete(owner._id);
  await lineExit(db, old.projectId, { laneId: old.laneId, kind, at: Date.now() });
}
export async function changeLineMark(
  db: Db,
  old: Mark,
  patch: Partial<Pick<Mark, 'stage' | 'held' | 'overlap'>>,
) {
  const stage = patch.stage ?? old.stage;
  const held = patch.held ?? old.held;
  const overlap = patch.overlap ?? old.overlap;
  const changed = stage !== old.stage || held !== old.held || overlap !== old.overlap;
  if (!changed) return;
  await db.patch(old._id, { ...patch, ...(stage !== old.stage ? { changedAt: Date.now() } : {}) });
}
/** Called with the overlap row already read by the ordinary Lane write. */
export async function trackLineLane(
  ctx: MutationCtx,
  sourceId: Id<'projectHostedOverlapLanes'>,
  lane: {
    projectId: Id<'hostedProjects'>;
    laneId: string;
    open: boolean;
    conflicted?: true;
    head: string;
    baseHead: string;
    landed?: { laneHead: string; revertedBy?: unknown };
  },
  before: { head: string; open: boolean } | null,
  held: boolean,
) {
  if (lane.landed?.laneHead === lane.head && !lane.landed.revertedBy) {
    const old = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_source', q => q.eq('sourceId', sourceId))
      .unique();
    if (old) await removeLineMark(ctx.db, old, 'landed');
    return;
  }
  if (before && lane.open && before.open && before.head === lane.head) {
    // Session/name/activity updates are not stage changes.
    const old = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_source', q => q.eq('sourceId', sourceId))
      .unique();
    if (old) return;
  }
  const old = await ctx.db
    .query('projectLiveLineLanes')
    .withIndex('by_source', q => q.eq('sourceId', sourceId))
    .unique();
  if (!lane.open) {
    if (old) await removeLineMark(ctx.db, old, 'set-aside');
    return;
  }
  const next = {
    stage: (lane.head === lane.baseHead ? 'editing' : 'saved') as Stage,
    held,
    overlap: Boolean(lane.conflicted),
  };
  if (old) {
    const owner = await lineOwner(ctx.db, old.laneId);
    await detachLineOwner(ctx.db, owner);
    const metadata = {
      kind: ownerKind,
      sourceId: old.laneId,
      projectId: lane.projectId,
      value: JSON.stringify({ markId: old._id, head: lane.head }),
    };
    if (owner) await ctx.db.replace(owner._id, metadata);
    else await ctx.db.insert('projectFinishReadRows', metadata);
    return changeLineMark(ctx.db, old, next);
  }
  const markId = await ctx.db.insert('projectLiveLineLanes', {
    projectId: lane.projectId,
    laneId: lane.laneId,
    sourceId,
    ...next,
    changedAt: Date.now(),
  });
  await ctx.db.insert('projectFinishReadRows', {
    kind: ownerKind,
    sourceId: lane.laneId,
    projectId: lane.projectId,
    value: JSON.stringify({ markId, head: lane.head }),
  });
}
/** Existing point patches (conflicts, lifecycle overlays, landed stamps) stay atomic. */
export async function patchLineLane(
  db: Db,
  sourceId: Id<'projectHostedOverlapLanes'>,
  patch: Record<string, unknown>,
) {
  if (!['open', 'conflicted'].some(key => key in patch)) return;
  const old = await db
    .query('projectLiveLineLanes')
    .withIndex('by_source', q => q.eq('sourceId', sourceId))
    .unique();
  if (!old) return;
  if (patch.open === false) await removeLineMark(db, old, patch.landed ? 'landed' : 'set-aside');
  else if ('conflicted' in patch) await changeLineMark(db, old, { overlap: Boolean(patch.conflicted) });
}
/** Main's small display snapshot shares the exit row; no Work revision is copied. With a scheduler (acceptance), a
 * landing in a new hour bucket also records `hour` and schedules the person-order update once (Item 3d5d8839): no
 * read is added, and a replay finds the same hour and schedules nothing. */
export async function writeLineMain(
  ctx: Pick<MutationCtx, 'db'> & Partial<Pick<MutationCtx, 'scheduler'>>,
  projectId: Id<'hostedProjects'>,
  main: { head: string; at?: string; actor?: string; automatic?: boolean; check?: string },
  countLanding = false,
) {
  const old = await lineSummary(ctx.db, projectId);
  const value = old ? JSON.parse(old.value) : {};
  if (JSON.stringify(value.main) === JSON.stringify(main)) return;
  // Seven UTC day buckets share this existing read/write. Replays and check-display patches do not count twice.
  if (countLanding && value.main?.head !== main.head && main.at) {
    const at = Date.parse(main.at);
    if (Number.isFinite(at)) {
      const day = Math.floor(at / 86_400_000);
      const week = value.publicWeek ?? { since: at, days: [] };
      const days: Array<{ day: number; count: number }> = week.days.filter(
        (row: { day: number }) => row.day >= day - 6 && row.day <= day,
      );
      const today = days.find(row => row.day === day);
      if (today) today.count++;
      else days.push({ day, count: 1 });
      value.publicWeek = { since: week.since, lastAt: at, days };
    }
  }
  value.main = main;
  const at = main.at ? Date.parse(main.at) : NaN;
  const hour = ctx.scheduler && Number.isFinite(at) ? nextActivityHour(value, at) : null;
  if (hour !== null) {
    value.hour = hour;
    await ctx.scheduler!.runAfter(0, internal.accountProjectOrder.touch, { projectId, hour });
  }
  const next = { kind: summaryKind, sourceId: String(projectId), projectId, value: JSON.stringify(value) };
  if (old) await ctx.db.replace(old._id, next);
  else await ctx.db.insert('projectFinishReadRows', next);
}
