// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { query } from './cliServer';
import { memberProject } from './projectAuthority';
import { landingRow } from './projectHostedLandingStore';
import { report } from './errors';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingState } from '../src/hosted-landing';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import type { Contribution } from '../src/person-days';
import { landingAcceptedBySchema } from '../src/landing-accepted-by';
import { recordPersonDays } from './personDays';
import { DAY_MS, isAccount, laneWindowStart, lanesByDay } from './statsLanes';
import {
  STATS_COMPARE_MIN_LANDINGS,
  STATS_DAY_MAX_LANDINGS,
  statsDay,
  rerunsWhileWaiting,
  statsDaySchema,
  statsWindow,
  type StatsDay,
  type StatsLanding,
} from '../src/stats-estimate';

/** Stats (Items a61d3c91, 2cf30e0a; docs/run-evidence.md#stats). A project's day closes once, when its
 * first landing of a later UTC day is recorded: one scheduled mutation per active project-day, nothing
 * for an idle project. The close reads each of that day's receipts and landing rows once (about four
 * documents and 10 KB per landing, tests/stats-close.test.mjs) and writes one row; the screen reads at
 * most STATS_READ_DAYS rows, re-run only by a close. */
export const STATS_CLOSE_LANDINGS = 1_000;
/** About three months of closed days; a busier project reads more bytes per day row, never more rows. */
export const STATS_READ_DAYS = 92;

const ms = (iso: string | undefined) => {
  const value = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};
/** One accepted landing for the replay, from its receipt and landing row only. */
export function statsLanding(
  receipt: HostedAcceptance,
  state: HostedLandingState | null,
  pending = 0,
): StatsLanding {
  const landedAt = ms(state?.timing?.committedAt) ?? ms(receipt.at)!;
  const runner = state?.counts?.runnerSeconds ?? null,
    discarded = pending > 0 ? null : discardedRunnerSeconds(state);
  const observedDiscarded = state?.counts?.discardedRunnerSeconds ?? 0;
  return {
    id: receipt.id,
    who: receipt.agentRun ?? (receipt.actor?.kind === 'person' ? 'by hand' : null),
    submittedAt: ms(state?.timing?.submittedAt) ?? ms(state?.at) ?? landedAt,
    landedAt,
    checkStartedAt: ms(state?.timing?.checkReservedAt),
    checkEndedAt: ms(state?.timing?.ciEndedAt),
    runnerSeconds: runner,
    discardedRunnerSeconds: discarded,
    // First try: no resubmission and no discarded check (a batch join is not a retry).
    attempts:
      state?.supersedes || observedDiscarded > 0 || (discarded ?? 0) > 0 ? 2 : discarded === 0 ? 1 : null,
    ranInFull: Boolean(state?.ranInFull),
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

export const closeDay = internalMutation({
  args: { projectId: v.id('hostedProjects'), day: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, day }) => {
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(day), 'BAD_ARGUMENT', 'A day is YYYY-MM-DD.');
    const existing = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', day))
      .unique();
    if (existing) return null;
    const from = Date.parse(`${day}T00:00:00.000Z`);
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
    for (const row of receipts.slice(0, STATS_CLOSE_LANDINGS)) {
      const receipt = JSON.parse(row.value) as HostedAcceptance;
      const request = await landingRow(ctx, { projectId, submissionId: receipt.submissionId }, false);
      const state = request ? (JSON.parse(request.value) as HostedLandingState) : null;
      if (request) contributionIds.set(landings.length, request.submissionId);
      landings.push(statsLanding(receipt, state, request?.runnerAccounting?.pending));
      contributions.push(...landingContributions(receipt, state));
    }
    // The replayed queue starts behind the newest closed day before this one.
    const before = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q => q.eq('projectId', projectId).lt('day', day))
      .order('desc')
      .first();
    // A person's day (Items 6a251b23, a9ad21c9): the Lanes started since the previous closed day, open or not, each
    // filed under its own day. A day with Lanes but no landing here never closes, so this close counts it.
    const lanes = await lanesByDay(ctx, projectId, laneWindowStart(before?.day, day), from + DAY_MS);
    for (const [laneDay, list] of [...lanes.byDay].sort((a, b) => a[0].localeCompare(b[0])))
      if (laneDay !== day) await recordPersonDays(ctx, projectId, laneDay, list);
    contributions.push(...(lanes.byDay.get(day) ?? []));
    await recordPersonDays(ctx, projectId, day, contributions);
    const freeAt = before ? statsDaySchema.parse(JSON.parse(before.value)).replay.freeAt : 0;
    const closed = statsDay(day, landings, freeAt);
    const value = canonicalPayload(
      receipts.length > STATS_CLOSE_LANDINGS ? { ...closed, partial: true } : closed,
    );
    const reruns = rerunsWhileWaiting(landings);
    const runnerContributions = [...contributionIds].map(([i, submissionId]) => ({
      submissionId,
      reruns: reruns[i]!,
    }));
    await ctx.db.insert('projectStatsDays', {
      projectId,
      day,
      value,
      ...(runnerContributions.length ? { runnerContributions } : {}),
    });
    return null;
  },
});

/** Stats for a project's members: the newest closed days, with each calendar month and the whole read
 * as windows. No clock argument: a new close is the only thing that re-runs it. */
export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see Stats.');
      await memberProject(ctx, projectId, user.subject);
      const rows = await ctx.db
        .query('projectStatsDays')
        .withIndex('by_project_and_day', q => q.eq('projectId', projectId))
        .order('desc')
        .take(STATS_READ_DAYS);
      const days = rows.map(row => statsDaySchema.parse(JSON.parse(row.value))).reverse();
      const months = new Map<string, StatsDay[]>();
      for (const d of days) months.set(d.day.slice(0, 7), [...(months.get(d.day.slice(0, 7)) ?? []), d]);
      return canonicalPayload({
        schema: 1,
        compareFrom: STATS_COMPARE_MIN_LANDINGS,
        through: days.at(-1)?.day ?? null,
        perDay: days.map(d => [d.day, d.landings]),
        months: [...months].reverse().map(([month, list]) => ({ month, ...statsWindow(list) })),
        all: { from: days[0]?.day ?? null, ...statsWindow(days) },
        bytesRead: rows.reduce((s, row) => s + row.value.length, 0),
      });
    } catch (error) {
      return report(error);
    }
  },
});
