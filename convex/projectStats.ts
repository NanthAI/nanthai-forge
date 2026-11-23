// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './server';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { expandUnreportedCounts, type HostedLandingState } from '../src/hosted-landing';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import { closedDay, dayBudgetStateSchema, judgeClosedDay } from '../src/landing-speed-alerts';
import { speedBudgets } from '../src/speed-budgets';
import { deliverBudgetEvents } from './projectLandingSpeed';
import type { Contribution } from '../src/person-days';
import { landingAcceptedBySchema } from '../src/landing-accepted-by';
import { recordPersonDays } from './personDays';
import { DAY_MS, STATS_LANE_LOOKBACK_DAYS, isAccount, laneWindowStart, lanesByDay } from './statsLanes';
import { PLANNING_HOT_MS, planningContributions, planningMembers, planningPartialDays } from './personWork';
import { statsQueueWidth, utcDay, utcHour } from './projectStatsClose';
import {
  STATS_CLOSE_TRIES,
  STATS_DAY_MAX_LANDINGS,
  firstTry,
  statsCarry,
  statsDay,
  statsFailedDay,
  rerunsWhileWaiting,
  statsDaySchema,
  type StatsLanding,
} from '../src/stats-estimate';
import { STATS_LANDINGS_KEEP, STATS_PEOPLE_KEEP, statsDayRuns, statsRoom } from './projectStatsRuns';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { workRecordOriginalDb } from './projectWorkRecordWriter';
import { metricRunKind } from './projectMetricReadProjection';
import { makeFunctionReference } from 'convex/server';
import {
  STATS_PARTS,
  STATS_RANGE_MAX_DAYS,
  previousRange,
  provisionalAt,
  rangeDays,
  statsAllReply,
  statsMonth,
  statsMonthSchema,
  statsRangeReply,
  validRange,
} from '../src/stats-period';

/** Stats (Items a61d3c91, 2cf30e0a; docs/run-evidence.md#stats). A project's day closes once, when its
 * first landing of a later UTC day is recorded: one scheduled mutation per active project-day, nothing
 * for an idle project. The close reads each of that day's receipts and landing rows once, the rows' own columns
 * without their body pages (about three documents and 7 KB per landing with the Intent's previous row,
 * tests/stats-close.test.mjs), and writes one row; the screen reads the rows of
 * one chosen range (at most STATS_RANGE_MAX_DAYS), re-run only by a close inside it. */
export const STATS_CLOSE_LANDINGS = 1_000;

/** The close's own probes and caps for check runs live in convex/projectStatsRuns.ts. */
const notMeasured = (value: string) => {
  const day = statsDaySchema.parse(JSON.parse(value));
  return day.schema === 2 ? day.failed : undefined;
};
const ms = (iso: string | undefined) => {
  const value = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};
/** One accepted landing for the replay, from its receipt and landing row only. */
export function statsLanding(
  receipt: Pick<HostedAcceptance, 'id' | 'at' | 'agentRun' | 'actor'>,
  state: HostedLandingState | null,
  pending = 0,
  /** An earlier submission of the same Intent ended without landing before this one (metrics 5.1's retry rule). */
  resubmitted = false,
  /** The landing row's agent-reported tokens (`agentTokens`), if any. */
  tokens?: number,
): StatsLanding {
  const landedAt = ms(state?.timing?.committedAt) ?? ms(receipt.at)!;
  const runner = state?.counts?.runnerSeconds ?? null,
    discarded = pending > 0 ? null : discardedRunnerSeconds(state);
  const observedDiscarded = state?.counts?.discardedRunnerSeconds ?? 0;
  // A discarded check whose minutes are not known yet (a stopped run still reporting, or an unreported superseded
  // check) is still a discarded check: not a first try, whatever it cost.
  const discardedCheck =
    observedDiscarded > 0 ||
    (discarded ?? 0) > 0 ||
    pending > 0 ||
    Boolean(state?.counts?.discardedRunnerUnknown);
  return {
    id: receipt.id,
    who: receipt.agentRun ?? (receipt.actor?.kind === 'person' ? 'by hand' : null),
    submittedAt: ms(state?.timing?.submittedAt) ?? ms(state?.at) ?? landedAt,
    landedAt,
    checkStartedAt: ms(state?.timing?.checkReservedAt),
    checkEndedAt: ms(state?.timing?.ciEndedAt),
    runnerSeconds: runner,
    discardedRunnerSeconds: discarded,
    // First try (one rule with metrics 5.1, src/stats-estimate.ts#firstTry): landed with no resubmission and no discarded check. A
    // batch join is not a retry.
    attempts: firstTry({
      resubmitted: resubmitted || Boolean(state?.supersedes),
      discardedCheck,
      known: discarded !== null,
    }),
    ranInFull: Boolean(state?.ranInFull),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** What one accepted landing counts for: a landing for its submitter (by one of their agent runs when it names one,
 * with the model the run declared), and a review for the person who accepted it after its check, unless that person
 * landed it by hand themself. */
export function landingContributions(
  receipt: HostedAcceptance,
  state: HostedLandingState | null,
): Contribution[] {
  const out: Contribution[] = [];
  const at = ms(receipt.at) ?? 0;
  const submitter = receipt.actor?.id;
  if (isAccount(submitter)) {
    const model = receipt.agentClient?.split(':')[1];
    out.push({
      kind: 'landing',
      person: submitter,
      at,
      ...(receipt.agentRun ? { run: receipt.agentRun, ...(model ? { model } : {}) } : {}),
    });
  }
  const stamped = landingAcceptedBySchema.safeParse(state?.acceptance?.acceptedBy);
  const accepted = stamped.success ? stamped.data : undefined;
  if (
    accepted?.kind === 'person' &&
    isAccount(accepted.actor) &&
    !(receipt.actor?.kind === 'person' && accepted.actor === submitter && !receipt.agentRun)
  )
    out.push({ kind: 'review', person: accepted.actor, at: ms(accepted.at) ?? at });
  return out;
}

/** Earlier submissions of one Intent read per landing for the resubmission test, newest first. Usually one row is
 * enough: the previous landing of the Intent, or the failure just before this one. */
export const STATS_RESUBMIT_LOOKBACK = 3;
/** Resubmitted (src/stats-estimate.ts#firstTry): an earlier submission of the same Intent ended without landing since the Intent's
 * previous landing. The scan stops at that landing, so a failure before it never reaches later landings. Landing rows
 * carry no Lane, so parallel Lanes of one Intent share the rule: a failure of one counts against the next landing of
 * the Intent only until that Lane lands. Only the rows' own columns are read (the original table): never their body
 * pages. */
export async function resubmittedBefore(
  ctx: Pick<MutationCtx, 'db'>,
  projectId: Id<'hostedProjects'>,
  request: Pick<Doc<'projectHostedLandingRequests'>, 'intentId' | '_creationTime'>,
) {
  if (!request.intentId) return false;
  const db = landingRequestOriginalDb(workRecordOriginalDb(ctx.db));
  const earlier = (before: number, n: number) =>
    db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_intent_and_held_intent', q =>
        q
          .eq('projectId', projectId)
          .eq('intentId', request.intentId)
          .eq('heldIntent', undefined)
          .lt('_creationTime', before),
      )
      .order('desc')
      .take(n);
  // Newest first: a landing of the Intent ends the look (the failures before it counted against that landing). The
  // newest row settles almost every case; only a parallel submission still running reads further.
  const decide = (rows: ReadonlyArray<{ phase: string }>) => {
    for (const row of rows) {
      if (row.phase === 'landed') return false;
      if (row.phase === 'terminal-failed') return true;
    }
    return null;
  };
  const newest = await earlier(request._creationTime, 1);
  if (newest.length < 1) return false;
  // The look further starts below the newest row, never reading it twice (review d6b0f1aa finding 9).
  return (
    decide(newest) ?? decide(await earlier(newest[0]!._creationTime, STATS_RESUBMIT_LOOKBACK - 1)) ?? false
  );
}

/** When the first check run in [from, to) started, or null: two indexed single-row probes (compact rows, then run rows
 * not projected yet). A close uses it to find a day with runs and no landing, which no landing would close. */
async function firstRunAt(ctx: MutationCtx, projectId: Id<'hostedProjects'>, from: number, to: number) {
  const compact = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q
        .eq('kind', metricRunKind)
        .eq('projectId', projectId)
        .gte('sourceCreatedAt', from)
        .lt('sourceCreatedAt', to),
    )
    .first();
  const raw = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_metrics_projection', q =>
      q
        .eq('projectId', projectId)
        .eq('metricsProjected', undefined)
        .gte('_creationTime', from)
        .lt('_creationTime', to),
    )
    .first();
  const times = [compact?.sourceCreatedAt, raw?._creationTime].filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : null;
}

export const closeDay = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    day: v.string(),
    /** Rebuild this day's Stats row by the current method and go on to the next day through `through`: never
     * touches person days (convex/projectStats.ts#recloseDays). */
    reclose: v.optional(v.object({ through: v.string() })),
    /** Close this later day next: a close that found an earlier day with runs and no landing closes that day first. */
    then: v.optional(v.string()),
    /** Today so far (Item 580b1a1a, scheduled by `refreshToday`): the same close over the open UTC day, written as a
     * provisional row. It probes no earlier day, judges no day budget, rolls no month and keeps no late-correction
     * lists; the day's real close replaces it. */
    provisional: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, day, reclose, then, provisional }) => {
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(day), 'BAD_ARGUMENT', 'A day is YYYY-MM-DD.');
    const now = Date.now();
    // A refresh that runs after midnight UTC leaves the day to its real close.
    if (provisional && (reclose || then || day !== utcDay(now))) return null;
    const closeNext = async () => {
      if (then)
        await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
          projectId,
          day: then,
        });
    };
    const existing = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', day))
      .unique();
    // A day left as not measured (src/stats-estimate.ts#statsFailedDay) is closed again when asked, and so is a day
    // closed so far only (provisional). A refresh runs at most once per UTC hour (a Stats open asks at most once in
    // STATS_TODAY_REFRESH_MS, a landing at its hour's first, Item 8d21cc9e): a second refresh in the same hour reads
    // this one row.
    const kept = existing ? statsDaySchema.parse(JSON.parse(existing.value)) : null;
    const unfinished = kept?.schema === 2 ? kept.failed : undefined;
    const keptSoFar = kept?.schema === 2 ? kept.provisional : undefined;
    if (provisional && existing && (keptSoFar === undefined || utcHour(keptSoFar) >= utcHour(now)))
      return null;
    if (existing && !reclose && !unfinished && keptSoFar === undefined && !provisional) {
      await closeNext();
      return null;
    }
    const from = Date.parse(`${day}T00:00:00.000Z`);
    // The replayed queue starts behind the newest closed day before this one.
    const before = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q => q.eq('projectId', projectId).lt('day', day))
      .order('desc')
      .first();
    // A day with check runs and no landing is closed by no landing: close the first such day since the previous
    // closed day before this one, then this one (each close probes once; idle projects schedule nothing). A close on
    // the day after the previous closed day has no gap and probes nothing.
    // Each such close first marks its day not measured (try 1), so a close that throws leaves the mark behind: a later
    // close tries it again, up to STATS_CLOSE_TRIES, then goes past it (review d6b0f1aa finding 5). One failing day
    // never stops the days after it.
    const prior = before ? statsDaySchema.parse(JSON.parse(before.value)) : null;
    const priorFailed = prior?.schema === 2 ? prior.failed : undefined;
    // A previous day left not measured wrote no person days: count its people's work from where its close would have.
    const since = priorFailed?.since;
    // The earlier-day probes are the real close's only: a provisional close neither tries nor marks an earlier day.
    const probe = !reclose && !provisional;
    // An earlier day still provisional is not closed: its real close did not finish (it threw, or has not run). It is
    // marked not measured (try 1), as a gap day is, and closed first, then this day; the tries then run as for any day.
    if (probe && before && prior?.schema === 2 && prior.provisional !== undefined) {
      const back = await ctx.db
        .query('projectStatsDays')
        .withIndex('by_project_and_day', q => q.eq('projectId', projectId).lt('day', before.day))
        .order('desc')
        .first();
      const backDay = back ? statsDaySchema.parse(JSON.parse(back.value)) : null;
      const backSince = backDay?.schema === 2 ? backDay.failed?.since : undefined;
      // A fresh row, so its creation time stays its close's (convex/projectCancelledRunDay.ts reads it).
      await ctx.db.delete(before._id);
      await ctx.db.insert('projectStatsDays', {
        projectId,
        day: before.day,
        value: canonicalPayload(
          statsFailedDay(
            before.day,
            statsCarry(backDay),
            1,
            utcDay(laneWindowStart(back?.day, before.day, backSince)),
          ),
        ),
        ...(back?.budgets ? { budgets: back.budgets } : {}),
      });
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
        projectId,
        day: before.day,
        then: day,
      });
      return null;
    }
    if (probe && before && priorFailed && priorFailed.tries < STATS_CLOSE_TRIES) {
      await ctx.db.patch(before._id, {
        value: canonicalPayload({ ...prior, failed: { ...priorFailed, tries: priorFailed.tries + 1 } }),
      });
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
        projectId,
        day: before.day,
        then: day,
      });
      return null;
    }
    const gapFrom = before ? Date.parse(`${before.day}T00:00:00.000Z`) + DAY_MS : from;
    if (probe && gapFrom < from) {
      const gapAt = await firstRunAt(ctx, projectId, gapFrom, from);
      if (gapAt !== null) {
        const gap = utcDay(gapAt);
        await ctx.db.insert('projectStatsDays', {
          projectId,
          day: gap,
          value: canonicalPayload(
            statsFailedDay(gap, statsCarry(prior), 1, utcDay(laneWindowStart(before?.day, gap, since))),
          ),
          // The day budgets' state carries through a gap day, even one that never closes.
          ...(before?.budgets ? { budgets: before.budgets } : {}),
        });
        await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
          projectId,
          day: gap,
          then: day,
        });
        return null;
      }
    }
    const receipts = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project', q =>
        q
          .eq('projectId', projectId)
          .gte('_creationTime', from)
          .lt('_creationTime', from + DAY_MS),
      )
      .order('asc')
      .take(Math.min(STATS_CLOSE_LANDINGS, STATS_DAY_MAX_LANDINGS) + 1);
    const landings: StatsLanding[] = [];
    const contributions: Contribution[] = [];
    const contributionIds = new Map<number, string>();
    const landedAttemptIds = new Set<string>();
    const resubmissions = new Set<number>();
    // A person's day (Items 6a251b23, a9ad21c9): the Lanes started since the previous closed day, open or not, and the
    // Items closed and planning comments in the same window (convex/personWork.ts), each under its own caps. Read
    // first, so the landings and runs after them see on the transaction's read meter what they used.
    const window = laneWindowStart(before?.day, day, since);
    const personReads = reclose
      ? null
      : {
          lanes: await lanesByDay(ctx, projectId, window, from + DAY_MS),
          planning: await planningContributions(ctx, projectId, window, from + DAY_MS),
          // The days of the window left not measured: their landings were never counted for anyone, so their people's
          // days are marked partial. Read only when a not-measured day opens the window (rare): its rows are small.
          unmeasured: new Set(
            since === undefined
              ? []
              : (
                  await ctx.db
                    .query('projectStatsDays')
                    .withIndex('by_project_and_day', q =>
                      q.eq('projectId', projectId).gte('day', since).lt('day', day),
                    )
                    .take(STATS_LANE_LOOKBACK_DAYS + 1)
                )
                  .filter(row => notMeasured(row.value))
                  .map(row => row.day),
          ),
        };
    // Each landing: its receipt (read above), its landing row's own columns (never its body pages: the close needs
    // none of the request) and the Intent's earlier submissions. They stop while the transaction still has room for
    // the person-day writes and the day's runs; a day they stop on is partial.
    const landingDb = landingRequestOriginalDb(workRecordOriginalDb(ctx.db));
    let landingsRead = 0;
    for (const row of receipts.slice(0, STATS_CLOSE_LANDINGS)) {
      if (!(await statsRoom(ctx, STATS_LANDINGS_KEEP))) break;
      landingsRead++;
      const receipt = JSON.parse(row.value) as HostedAcceptance;
      const request = await landingDb
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_submission', q =>
          q.eq('projectId', projectId).eq('submissionId', receipt.submissionId),
        )
        .unique();
      const state = request
        ? (expandUnreportedCounts(JSON.parse(request.value)) as HostedLandingState)
        : null;
      if (request) contributionIds.set(landings.length, request.submissionId);
      if (state) landedAttemptIds.add(state.attemptId);
      const resubmitted = request ? await resubmittedBefore(ctx, projectId, request) : false;
      if (resubmitted) resubmissions.add(landings.length);
      landings.push(
        statsLanding(receipt, state, request?.runnerAccounting?.pending, resubmitted, request?.agentTokens),
      );
      contributions.push(...landingContributions(receipt, state));
    }
    let planningPartial =
      reclose && existing ? statsDaySchema.parse(JSON.parse(existing.value)).planningPartial === true : false;
    let peoplePartial =
      reclose && existing
        ? (() => {
            const kept = statsDaySchema.parse(JSON.parse(existing.value));
            return kept.schema === 2 && kept.peoplePartial === true;
          })()
        : false;
    if (personReads) {
      const { lanes, planning, unmeasured } = personReads;
      const byDay = new Map([...lanes.byDay].map(([d, list]) => [d, [...list]] as const));
      for (const c of planning.contributions)
        byDay.set(utcDay(c.at), [...(byDay.get(utcDay(c.at)) ?? []), c]);
      // Days whose planning work was not all counted: past a cap, or older than the change rows Convex still holds (only
      // when the project is that old). Their entries are marked partial, and so is this close's day.
      const now = Date.now();
      let project: Doc<'hostedProjects'> | null | undefined;
      const projectRow = async () =>
        project === undefined ? (project = await ctx.db.get(projectId)) : project;
      const partial = planningPartialDays({
        window,
        cut: planning.cut,
        // Read only when the window reaches past the kept change rows (a first close, or one after a long gap).
        projectCreated: window < now - PLANNING_HOT_MS ? ((await projectRow())?._creationTime ?? 0) : now,
        now,
      });
      contributions.push(...(byDay.get(day) ?? []));
      // A partial close may have left someone's only planning work unread (past the change-row cap, or archived), so
      // nothing of theirs would carry the mark: everyone who can do planning work here gets it on this day (no counts,
      // so no activity is shown for it). Read only on this rare path.
      const row = partial.any ? await projectRow() : null;
      if (row)
        for (const person of await planningMembers(ctx, row))
          if (!contributions.some(c => c.person === person))
            contributions.push({ kind: 'partial', person, at: from });
      // Each person-day is one read and one write, under the transaction's meter: a day with more people than it holds
      // closes with the rest unwritten and is marked (peoplePartial), never failing whole (Item a61d3c91, d5857b5c).
      // Oldest day first, this close's own day last.
      const room = () => statsRoom(ctx, STATS_PEOPLE_KEEP);
      const days: Array<[string, Contribution[], boolean]> = [
        ...[...byDay]
          .filter(([d]) => d !== day)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(
            ([d, list]) =>
              [d, list, partial.has(d) || unmeasured.has(d)] as [string, Contribution[], boolean],
          ),
        // Landings left unread (the day's cap, or the room the meter keeps) leave people's landings short too (review
        // d6b0f1aa finding 4).
        [day, contributions, partial.has(day) || receipts.length > landingsRead],
      ];
      for (const [d, list, mark] of days)
        if (!(await recordPersonDays(ctx, projectId, d, list, { partial: mark, room }))) {
          peoplePartial = true;
          break;
        }
      planningPartial = partial.any;
    }

    const carry = statsCarry(prior);
    const runs = await statsDayRuns(ctx, projectId, from, from + DAY_MS, landedAttemptIds);
    const closed = statsDay(day, landings, runs, carry, await statsQueueWidth(ctx, projectId));
    // Today so far, or a re-close of a day still provisional: rebuilt figures, still provisional, so the day's real
    // close (person days, day budgets, late-correction lists) still runs.
    const soFar = provisional ? now : reclose ? keptSoFar : undefined;
    // Which cap stopped the landings: the day's own cap (more receipts than the close takes), else the transaction's room.
    const landingStop =
      landingsRead < Math.min(receipts.length, STATS_CLOSE_LANDINGS) ? 'landings:meter' : 'landings:cap';
    const value = canonicalPayload({
      ...(receipts.length > landingsRead
        ? {
            ...closed,
            partial: true,
            stoppedBy: [...(closed.stoppedBy ?? []), landingStop].sort(),
          }
        : closed),
      ...(planningPartial ? { planningPartial: true as const } : {}),
      ...(peoplePartial ? { peoplePartial: true as const } : {}),
      ...(soFar !== undefined ? { provisional: soFar } : {}),
    });
    const reruns = rerunsWhileWaiting(landings);
    const runnerContributions = [...contributionIds].map(([i, submissionId]) => ({
      submissionId,
      reruns: reruns[i]!,
      ...(resubmissions.has(i) ? { resubmitted: true } : {}),
    }));
    const lateRuns = runs.unknownRuns.map(([runId, bucket]) => ({ runId, bucket }));
    // Day budgets (the daily waste tripwire, Item a217b83e): judged once per ordinary close, from the rows this close
    // already read, carrying their state from the previous closed day's row. Nothing on the landing path. A day with
    // no landing carries the state unchanged; a re-close leaves it as it was. Landings the close did not read count
    // as unknown.
    const unread = receipts.length - landingsRead;
    const judged =
      probe && receipts.length
        ? judgeClosedDay(
            before?.budgets ? dayBudgetStateSchema.parse(JSON.parse(before.budgets)) : undefined,
            closedDay(day, landings, unread),
            speedBudgets,
          )
        : null;
    // A provisional row carries the previous day's state unchanged (Metrics reads the newest row's ratchet).
    const budgets = reclose
      ? {}
      : provisional
        ? { budgets: before?.budgets }
        : {
            budgets: judged
              ? Object.keys(judged.state).length
                ? canonicalPayload(judged.state)
                : undefined
              : before?.budgets,
          };
    // Late corrections (convex/projectCancelledRunDay.ts) apply to closed days only: a provisional row keeps no lists.
    const lists =
      soFar !== undefined
        ? {}
        : {
            ...(runnerContributions.length ? { runnerContributions } : {}),
            ...(lateRuns.length ? { lateRuns } : {}),
          };
    // An ordinary close replaces a provisional row or a not-measured mark with a fresh row, so a closed row's creation
    // time is its close's (convex/projectCancelledRunDay.ts compares it with correction baselines). A re-close patches.
    const replace = !reclose && (keptSoFar !== undefined || unfinished !== undefined);
    if (existing && !replace)
      await ctx.db.patch(existing._id, {
        value,
        runnerContributions: soFar === undefined ? runnerContributions : undefined,
        lateRuns: soFar === undefined ? lateRuns : undefined,
        ...budgets,
      });
    // A re-close writes no row for a day with no landings and no check runs; an ordinary close always marks its day
    // closed.
    else if (existing || !reclose || landings.length || runs.all.runs + runs.audits.runs > 0) {
      if (existing) await ctx.db.delete(existing._id);
      await ctx.db.insert('projectStatsDays', {
        projectId,
        day,
        value,
        ...lists,
        ...(budgets.budgets ? { budgets: budgets.budgets } : {}),
      });
    }
    if (judged) await deliverBudgetEvents(ctx, projectId, judged.events);
    if (reclose && day < reclose.through)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
        projectId,
        day: utcDay(from + DAY_MS),
        reclose,
      });
    // A month closes for All time once a day of a later month closes (or a re-close finishes it): one rollup a month.
    const month = day.slice(0, 7);
    const rolled = provisional
      ? null
      : reclose
        ? (day === reclose.through || utcDay(from + DAY_MS).slice(0, 7) !== month) &&
          month < utcDay(Date.now()).slice(0, 7)
          ? month
          : null
        : before && before.day.slice(0, 7) < month
          ? before.day.slice(0, 7)
          : null;
    if (rolled)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:rollMonth'), {
        projectId,
        month: rolled,
      });
    await closeNext();
    return null;
  },
});

/** Months All time reads at most (twenty years), and the day rows after the newest rolled month. */
export const STATS_ALL_MONTHS = 240;

/** A closed month's rollup for All time (src/stats-period.ts#statsMonth), from its day rows (at most 31), replacing any
 * earlier one. Scheduled once a month per active project by the close (never for an idle project), and by a re-close. */
export const rollMonth = internalMutation({
  args: { projectId: v.id('hostedProjects'), month: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, month }) => {
    invariant(/^\d{4}-\d{2}$/.test(month), 'BAD_ARGUMENT', 'A month is YYYY-MM.');
    const rows = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q =>
        q.eq('projectId', projectId).gte('day', `${month}-01`).lte('day', `${month}-31`),
      )
      .take(31);
    // A provisional row (today so far, Item 580b1a1a) is never a month's input: its day's real close replaces it.
    const days = rows
      .map(row => statsDaySchema.parse(JSON.parse(row.value)))
      .filter(d => provisionalAt(d) === null);
    const value = canonicalPayload(statsMonth(month, days));
    const existing = await ctx.db
      .query('projectStatsMonths')
      .withIndex('by_project_and_month', q => q.eq('projectId', projectId).eq('month', month))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { value });
    else if (rows.length) await ctx.db.insert('projectStatsMonths', { projectId, month, value });
    return null;
  },
});

/** Rebuild a project's Stats day rows by the current method, oldest first, one scheduled mutation per day (each
 * hands its replayed queues to the next), from `from` through `through` (closed days only: before today, UTC). Days
 * with landings or check runs and no row are closed too (Stats rows before the close existed); person days are never
 * touched. Run once after a method change:
 * `npx convex run projectStats:recloseDays '{"projectId":"…","from":"2026-11-10","through":"2026-11-18"}'`. */
export const recloseDays = internalMutation({
  args: { projectId: v.id('hostedProjects'), from: v.string(), through: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, from, through }) => {
    invariant(
      rangeDays({ from, to: through }) > 0 && rangeDays({ from, to: through }) <= 400,
      'BAD_ARGUMENT',
      'Re-close 1 to 400 days, oldest first.',
    );
    invariant(
      through < utcDay(Date.now()),
      'BAD_ARGUMENT',
      'Re-close closed days only: end before today (UTC).',
    );
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
      projectId,
      day: from,
      reclose: { through },
    });
    return null;
  },
});

/** Stats for a project's members over one chosen range of closed UTC days (src/stats-period.ts): the day rows in
 * that range only, at most STATS_RANGE_MAX_DAYS, re-aggregated into one part: the page's head, or one fold the reader
 * opened. The screen passes the range, so a new close inside it is the only thing that re-runs a read; no clock
 * argument. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    from: v.string(),
    to: v.string(),
    part: v.optional(v.union(...STATS_PARTS.map(part => v.literal(part)))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, from, to, part = 'head' }) => {
    try {
      invariant(
        validRange({ from, to }),
        'BAD_ARGUMENT',
        `Choose a range of 1 to ${STATS_RANGE_MAX_DAYS} days.`,
      );
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see Stats.');
      await memberProject(ctx, projectId, user.subject);
      const range = (a: string, b: string) =>
        ctx.db
          .query('projectStatsDays')
          .withIndex('by_project_and_day', q => q.eq('projectId', projectId).gte('day', a).lte('day', b))
          .take(STATS_RANGE_MAX_DAYS);
      const rows = await range(from, to);
      // The self-trend also reads the same number of days just before (only when its fold is open).
      const before =
        part === 'trend' ? await range(previousRange({ from, to }).from, previousRange({ from, to }).to) : [];
      const parse = (list: typeof rows) => list.map(row => statsDaySchema.parse(JSON.parse(row.value)));
      return canonicalPayload({
        ...statsRangeReply(parse(rows), { from, to }, part, parse(before)),
        bytesRead: [...rows, ...before].reduce((s, row) => s + row.value.length, 0),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** All time for a project's members: each closed month's stored rollup (about 12 rows a year, at most STATS_ALL_MONTHS)
 * and the day rows after the newest one (the open month; at most STATS_RANGE_MAX_DAYS, the newest kept), never every
 * day. One part at a time, as `read`; re-run only by a close or a rollup. */
export const readAll = query({
  args: {
    projectId: v.id('hostedProjects'),
    part: v.optional(v.union(...STATS_PARTS.map(part => v.literal(part)))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, part = 'head' }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see Stats.');
      await memberProject(ctx, projectId, user.subject);
      const months = await ctx.db
        .query('projectStatsMonths')
        .withIndex('by_project_and_month', q => q.eq('projectId', projectId))
        .take(STATS_ALL_MONTHS);
      const newest = months.at(-1)?.month;
      const tail = (
        await ctx.db
          .query('projectStatsDays')
          .withIndex('by_project_and_day', q =>
            newest === undefined
              ? q.eq('projectId', projectId)
              : q.eq('projectId', projectId).gt('day', `${newest}-99`),
          )
          .order('desc')
          .take(STATS_RANGE_MAX_DAYS)
      ).reverse();
      return canonicalPayload({
        ...statsAllReply(
          months.map(row => statsMonthSchema.parse(JSON.parse(row.value))),
          tail.map(row => statsDaySchema.parse(JSON.parse(row.value))),
          part,
        ),
        bytesRead: [...months, ...tail].reduce((s, row) => s + row.value.length, 0),
      });
    } catch (error) {
      return report(error);
    }
  },
});
