// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { lineOwner, detachLineOwner } from './projectLiveLineOwners';
import { measureSize } from './projectLiveLineOpen';
import { internal } from './_generated/api';
import { nextActivityHour } from './accountProjectOrderHour';
import { readFlowLandings } from './projectLiveLineRecovery';
import { recordDay, type WeekDay } from '../src/public-time-to-main';
import { flowDay, flowMain, HOUR_MS, stepFlow, utcDayStart, type FlowStep } from '../src/flow-day';
import { metricAliasGeneration } from '../src/self-metrics-context';

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
/** The top bar's main figure for agents (Item 32e8de50): one read of the summary row the top bar already reads,
 * made only by a bare status that asks for it. The rolling day's landing and first-try rows (at most a day of each),
 * not a figure: the caller works out "today" with its own clock, so a cached query never serves yesterday's. */
export async function readMainDay(
  db: Pick<Db, 'query'>,
  projectId: Id<'hostedProjects'>,
  /** Also main's state from the same row (Item 8d21cc9e), so `nforge status` says it beside the figure. Only the
   * capabilities reply sends it: a CLI from before it drops the unknown keys at its reply boundary
   * (src/hosted-response.ts), while the clone's main read parses its day strictly. */
  state = false,
) {
  const summary = await lineSummary(db, projectId);
  const day = flowDay(summary ? JSON.parse(summary.value).flow : undefined);
  return {
    hours: day.hours.slice(-24),
    first: (day.first ?? []).slice(-24),
    ...(state && day.main ? { main: day.main } : {}),
    ...(state && day.audit ? { audit: day.audit } : {}),
  };
}
/** Only an explicit removal updates the small latest-exit snapshot. A landing or failed check that writes it also
 * steps the Flow view's day (src/flow-day.ts) in the same write; `step` alone writes only when it counts something. */
export async function lineExit(
  db: Db,
  projectId: Id<'hostedProjects'>,
  exit: { laneId: string; kind: 'landed' | 'set-aside'; at: number } | null,
  step?: FlowStep,
  /** Re-read the stored size too (a set-aside; a landing reads no shards). */
  measure = false,
) {
  const old = await lineSummary(db, projectId);
  const value = old ? JSON.parse(old.value) : {};
  // Last removal only, never a history/replay. Missing events never imply an exit kind.
  if (exit) value.exit = exit;
  if (measure) await measureSize(db, projectId, value, exit?.at ?? Date.now());
  if (step) value.flow = stepFlow(value.flow, exit?.at ?? Date.now(), step);
  const next = { kind: summaryKind, sourceId: String(projectId), projectId, value: JSON.stringify(value) };
  if (old) await db.replace(old._id, next);
  else await db.insert('projectFinishReadRows', next);
}
/** main's audit verdict flipped (red, or green again): the Flow view's main state. A red episode that ends counts
 * once, as reverted or fixed on top by the audit's own recovery verdict (the one Needs me's Main broke row shows); a
 * flake counts as neither. Written only on a flip, never per landing or per audit. */
export async function lineMainState(
  db: Db,
  projectId: Id<'hostedProjects'>,
  verdict: { red: boolean; at: string; ended?: 'reverted' | 'fixed-on-top'; sequence?: number },
) {
  const old = await lineSummary(db, projectId);
  const value = old ? JSON.parse(old.value) : {};
  const at = Date.parse(verdict.at);
  const when = Number.isFinite(at) ? at : Date.now();
  const before = flowDay(value.flow).main;
  const flow = flowMain(value.flow, verdict.red, when, verdict.sequence);
  // An ended red counts in the hour it began while that hour is still kept (Item 8d21cc9e): "main failed today" counts
  // a red on the day it began, open (src/flow-day.ts mainFailedToday) or ended, never on two days.
  const began =
    before?.red && before.since <= when && before.since > when - 23 * HOUR_MS ? before.since : when;
  const next = verdict.ended
    ? stepFlow(flow, began, verdict.ended === 'reverted' ? { reverted: 1 } : { fixedOnTop: 1 })
    : flow;
  if (JSON.stringify(next) === JSON.stringify(value.flow)) return;
  value.flow = next;
  const row = { kind: summaryKind, sourceId: String(projectId), projectId, value: JSON.stringify(value) };
  if (old) await db.replace(old._id, row);
  else await db.insert('projectFinishReadRows', row);
}
export async function removeLineMark(db: Db, old: Mark, kind: 'landed' | 'set-aside') {
  await db.delete(old._id);
  const owner = await lineOwner(db, old.laneId);
  await detachLineOwner(db, owner);
  if (owner) await db.delete(owner._id);
  // A landing reads no storage shards (the landing cost guard holds its reads); a set-aside may re-measure the size.
  await lineExit(
    db,
    old.projectId,
    { laneId: old.laneId, kind, at: Date.now() },
    undefined,
    kind === 'set-aside',
  );
}
/** A mark's check key and main-red hold ride its stage/held patches (Item 85f456c1); a key in `patch` set to
 * undefined clears it, a key left out keeps it. */
export async function changeLineMark(
  db: Db,
  old: Mark,
  patch: Partial<Pick<Mark, 'stage' | 'held' | 'overlap' | 'check' | 'mainRed' | 'fix'>>,
) {
  const stage = patch.stage ?? old.stage;
  const held = patch.held ?? old.held;
  const overlap = patch.overlap ?? old.overlap;
  const check = 'check' in patch ? patch.check : old.check;
  const mainRed = 'mainRed' in patch ? patch.mainRed : old.mainRed;
  const fix = 'fix' in patch ? patch.fix : old.fix;
  const changed =
    stage !== old.stage ||
    held !== old.held ||
    overlap !== old.overlap ||
    check !== old.check ||
    mainRed !== old.mainRed ||
    fix !== old.fix;
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
    // A new head leaves its submission: no check key, no main-red hold.
    check: undefined,
    mainRed: undefined,
    fix: undefined,
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
    stage: next.stage,
    held: next.held,
    overlap: next.overlap,
    changedAt: Date.now(),
  });
  await ctx.db.insert('projectFinishReadRows', {
    kind: ownerKind,
    sourceId: lane.laneId,
    projectId: lane.projectId,
    value: JSON.stringify({ markId, head: lane.head }),
  });
}
/** Existing point patches (conflicts, lifecycle overlays, landed stamps, supersession) stay atomic. */
export async function patchLineLane(
  db: Db,
  sourceId: Id<'projectHostedOverlapLanes'>,
  patch: Record<string, unknown>,
) {
  if (!['open', 'conflicted', 'superseded'].some(key => key in patch)) return;
  const old = await db
    .query('projectLiveLineLanes')
    .withIndex('by_source', q => q.eq('sourceId', sourceId))
    .unique();
  if (!old) return;
  if (patch.open === false) await removeLineMark(db, old, patch.landed ? 'landed' : 'set-aside');
  // Superseded (its work landed through another Lane, Issue f5c4d136): the hold an ended submission left (stage
  // Saved) waits on nobody, so it lifts in the patch that leaves presence. A live submission's hold (queued, checking
  // or ready) stays its own, and the mark keeps its binding and `retried`.
  else if (patch.superseded) {
    if (old.held && old.stage === 'saved') await changeLineMark(db, old, { held: false, fix: undefined });
  } else if ('conflicted' in patch) await changeLineMark(db, old, { overlap: Boolean(patch.conflicted) });
}
/** Main's small display snapshot shares the exit row; no Work revision is copied. With a scheduler (acceptance), a
 * landing in a new hour bucket also records `hour` and schedules the person-order update once (Item 3d5d8839): no
 * read is added, and a replay finds the same hour and schedules nothing. `landings` counts the receipts a new head
 * carries (a batch publishes several under one head, Item 85f456c1); a replay of the same head counts none. */
export async function writeLineMain(
  ctx: Pick<MutationCtx, 'db'> & Partial<Pick<MutationCtx, 'scheduler'>>,
  projectId: Id<'hostedProjects'>,
  main: { head: string; at?: string; actor?: string; automatic?: boolean; check?: string },
  landings = 0,
  priorServerReceipt = false,
  firstSequence?: number,
  /** Each landing's save-to-main seconds (null: not recorded), for the week's median time to main (8947a779). */
  toMain: readonly (number | null)[] = [],
) {
  const old = await lineSummary(ctx.db, projectId);
  const value = old ? JSON.parse(old.value) : {};
  if (firstSequence !== undefined && (value.landingSequence ?? -1) >= firstSequence) return;
  if (firstSequence === undefined && JSON.stringify(value.main) === JSON.stringify(main)) return;
  const previousSequence = value.landingSequence ?? null;
  const continuity = value.metricContinuity;
  const carried =
    continuity?.generation === metricAliasGeneration &&
    continuity.head === value.main?.head &&
    continuity.sequence === previousSequence;
  // Seven UTC day buckets share this existing read/write. Replays and check-display patches do not count twice.
  // A new landing moves the head or, for a batch whose receipts leave main's tree as it was, the time: either counts.
  // A replay sends the same snapshot and returned above; a check-display patch keeps head and time.
  if (
    landings > 0 &&
    main.at &&
    (firstSequence !== undefined || value.main?.head !== main.head || value.main?.at !== main.at)
  ) {
    const at = Date.parse(main.at);
    if (Number.isFinite(at)) {
      const day = Math.floor(at / 86_400_000);
      const week = value.publicWeek ?? { since: at, days: [] };
      const days: WeekDay[] = week.days.filter(
        (row: { day: number }) => row.day >= day - 6 && row.day <= day,
      );
      const today = days.find(row => row.day === day);
      // Receipt creationTime is the time of this database write; the supplied
      // publication timestamp can have been captured before entering the mutation.
      const now = Date.now();
      const dayStart = utcDayStart(now);
      const flow = flowDay(value.flow);
      const dayHour = dayStart / HOUR_MS;
      const priorLanded = flow.hours.reduce((count, row) => count + (row[0] >= dayHour ? row[1] : 0), 0);
      const previousAt = Date.parse(value.main?.at ?? '');
      // A legacy snapshot may outlive its missing or incomplete Flow day. Seed from the same
      // receipt replay as the operator repair. Append this transaction's own receipts once below.
      // Once seeded, the current day only steps the count; ordinary publications read no receipts.
      const missing =
        flow.repair?.day !== dayStart &&
        ((dayStart === utcDayStart(at) && (today?.count ?? 0) > priorLanded) ||
          (priorServerReceipt &&
            (value.landingSequence === undefined ||
              !value.main ||
              (!priorLanded && previousAt >= dayStart && previousAt <= now))));
      const base = missing ? (await readFlowLandings(ctx.db, projectId, now, flow, firstSequence)).day : flow;
      value.flow = stepFlow(base, now, { landed: landings });
      if (firstSequence !== undefined) value.landingSequence = firstSequence + landings - 1;
      recordDay(days, day, landings, toMain);
      value.publicWeek = { since: week.since, lastAt: at, days };
    }
  }
  // Only a coverage grant starts continuity. A writer returning after a
  // missed acceptance cannot turn an old stamp into a current one.
  if (firstSequence !== undefined && value.landingSequence !== previousSequence) {
    if (carried && (previousSequence === null || firstSequence === previousSequence + 1))
      value.metricContinuity = {
        generation: metricAliasGeneration,
        head: main.head,
        sequence: value.landingSequence,
      };
    else delete value.metricContinuity;
  } else if (value.main?.head !== main.head) delete value.metricContinuity;
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
