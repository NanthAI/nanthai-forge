// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import {
  addAuditSeconds,
  landingSpeedSample,
  type LandingSpeedSample,
  landingSpeedStateSchema,
  observeLandingSpeed,
  speedBudgetIssue,
  speedWindow,
  speedBudgetMessage,
  type LandingSpeedState,
} from '../src/landing-speed-alerts';
import { speedBudgets } from '../src/speed-budgets';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import { scheduleStatsClose } from './projectStatsClose';
import { addGuardFailure, guardCandidates } from '../src/preflight-guard-learning';

/** Speed and cost budgets, judged inside the mutation that lands: one indexed read and one write of a
 * row of about 3.5 KB; no new Convex call. `attempts` is the accepted attempt's ordinal plus one, from
 * the attempt the caller already loaded. Only a budget that breaks or recovers (rare, never while it
 * stays broken) reads the project and schedules the existing stall-alert delivery plus one Issue write. */
export async function recordLandingSpeed(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
  attempts: number | null = null,
  passedAt?: number,
  checkKind?: 'full' | 'scoped' | 'batch',
) {
  const sample = landingSpeedSample(state, attempts, passedAt, checkKind);
  return sample ? applyLandingSample(ctx, projectId, sample) : [];
}

/** A main audit run ended: its shard seconds join the newest landing's sample. One indexed read and one
 * patch of the row the accept mutation keeps anyway, once per audit run; no new call. */
export async function recordAuditRunnerSeconds(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  seconds: number,
) {
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!row) return;
  try {
    const next = addAuditSeconds(landingSpeedStateSchema.parse(JSON.parse(row.value)), seconds);
    await ctx.db.patch(row._id, { value: canonicalPayload(next) });
  } catch {
    // A metric never fails the audit: an unreadable row is replaced by the next landing's fresh window.
  }
}

/** A failed check teaches the preflight guard set (13ea93bf): the landing row's gate evidence (what
 * its preflight ran) and one patch of this row's `guards`. Check failures only, about 1 landing in
 * 10: two indexed reads and one write. A project with no landed sample yet learns nothing (no window
 * to read p against). A metric: it never fails the landing. */
export async function recordGuardFailure(ctx: MutationCtx, state: HostedLandingState) {
  try {
    const projectId = state.projectId as Id<'hostedProjects'>;
    const landing = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q => q.eq('projectId', projectId).eq('submissionId', state.id))
      .unique();
    const row = await ctx.db
      .query('projectLandingSpeed')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    if (!row) return;
    const guards = addGuardFailure(
      row.guards,
      state,
      { ran: landing?.preflightRan, runs: landing?.preflightRuns },
      Date.now(),
    );
    if (guards !== null) await ctx.db.patch(row._id, { guards });
  } catch {
    // The failure is already recorded; learning waits for the next one.
  }
}

/** The guard-set candidates for a start reply, or null when the caller already holds revision
 * `known`. One indexed read of this row (about 4 KB); no write. */
export async function guardSetReply(ctx: QueryCtx, projectId: Id<'hostedProjects'>, known: string) {
  // A hint: nothing here may fail the start that carries it.
  try {
    const row = await ctx.db
      .query('projectLandingSpeed')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    let at: number[] = [];
    try {
      at = row
        ? speedWindow(landingSpeedStateSchema.parse(JSON.parse(row.value)).samples).map(sample => sample[0])
        : [];
    } catch {
      at = [];
    }
    const set = guardCandidates(row?.guards, at, Date.now());
    return set.rev === known ? null : set;
  } catch {
    return null;
  }
}

/** The capability reply's field for a caller that sent revision `known`: nothing when it sent
 * none or already holds the project's. */
export async function guardSetField(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  known: string | undefined,
) {
  const guardSet = known === undefined ? null : await guardSetReply(ctx, projectId, known);
  return guardSet ? { guardSet } : {};
}

async function applyLandingSample(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  sample: LandingSpeedSample,
) {
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  // A metric never fails a landing: an unreadable or older row starts a fresh window.
  let previous: LandingSpeedState | null;
  try {
    previous = row ? landingSpeedStateSchema.parse(JSON.parse(row.value)) : null;
  } catch {
    previous = null;
  }
  const { state: next, events } = observeLandingSpeed(previous, sample, speedBudgets);
  const value = canonicalPayload(next);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert('projectLandingSpeed', { projectId, value });
  // The first landing of a later UTC day closes the previous one for Stats (a61d3c91): no read added.
  await scheduleStatsClose(ctx, projectId, previous?.samples.at(-1)?.[0], sample.at);
  return deliverBudgetEvents(ctx, projectId, events);
}

/** Owner message for every event, P0 Issue write for a break or recovery; also used by the Stats day close. */
export async function deliverBudgetEvents(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  events: ReturnType<typeof observeLandingSpeed>['events'],
) {
  if (!events.length) return events;
  const project = await ctx.db.get(projectId);
  if (!project) return events;
  const settings = effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;
  for (const event of events) {
    // The Issue is the durable record of a break, so it is written whether or not owner channels are on.
    // A ratchet, its undo and a too-little-data note are recorded in this row (line, landing, reason)
    // and open no Issue: only the file max breaking is a P0.
    if (event.kind === 'broken' || event.kind === 'recovered')
      await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectLandingSpeedIssue:write'), {
        projectId,
        owner: project.owner,
        issue: canonicalPayload(speedBudgetIssue(event, projectId, speedBudgets)),
      });
    if (settings.enabled)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectHostedLandingStallAlert:deliver'),
        { ...speedBudgetMessage(event, project.name, speedBudgets), settings: canonicalPayload(settings) },
      );
  }
  return events;
}

/** Late usage edits the existing window once, without inserting a landing or
 * scheduling a day close. Only retained samples are adjusted; no history scan. */
export async function correctLandingRunnerCosts(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  landings: HostedLandingState[],
) {
  if (!landings.some(s => s.phase === 'landed' && s.acceptance)) return;
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!row) return;
  const parsed = landingSpeedStateSchema.safeParse(JSON.parse(row.value));
  if (!parsed.success) return;
  const state = parsed.data;
  let changed = false;
  // The window only: a recheck reserve row is read for its accepted-run seconds, never its discarded ones.
  const window = speedWindow(state.samples);
  for (const landing of landings) {
    const sample = window.find(s => s[3] === landing.acceptance?.receiptId);
    if (!sample) continue;
    sample[7] ??= [null, null, null, null, null, null];
    sample[7][4] = discardedRunnerSeconds(landing);
    changed = true;
  }
  if (!changed) return;
  const latest = state.samples.at(-1)!;
  const observed = observeLandingSpeed(
    { ...state, samples: state.samples.slice(0, -1) },
    {
      at: latest[0],
      toMain: latest[1],
      check: latest[2],
      id: latest[3],
      settle: latest[4] ?? null,
      attempts: latest[5],
      writes: latest[6],
      counts: latest[7],
      saveMs: latest[8],
      preflightMs: latest[9],
      // Re-observed as stored (fa2c1383): dropping these erased the newest landing's check kind, so a
      // recheck whose late usage came in never counted toward the keep rule's measured costs.
      passToLand: latest[10],
      kind: latest[11],
      stages: { queue: null, check: null, settle: null },
    },
    speedBudgets,
  );
  await ctx.db.patch(row._id, { value: canonicalPayload(observed.state) });
  await deliverBudgetEvents(ctx, projectId, observed.events);
}

/** Drill (run by an operator with `npx convex run`, never by the product): push one window of synthetic
 * landings through the real path above, so a budget breaks (or recovers) and the real alert and Issue
 * write fire. `break` returns the row it replaced; `restore` puts that row back, so the project's own
 * window is not left holding synthetic landings. Landing ids read `drill0000`..; the Issue stays on the board. */
export const drill = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    mode: v.union(v.literal('break'), v.literal('recover'), v.literal('restore')),
    original: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, mode, original }) => {
    const row = await ctx.db
      .query('projectLandingSpeed')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    if (mode === 'restore') {
      if (row && original) await ctx.db.patch(row._id, { value: original });
      else if (row) await ctx.db.delete(row._id);
      return 'restored';
    }
    const events = [];
    const window = speedBudgets.window.landings;
    // Strictly after the newest stored landing, so synthetic samples never interleave with real ones.
    const newest = row ? ((JSON.parse(row.value).samples?.at(-1)?.[0] as number | undefined) ?? 0) : 0,
      start = Math.max(Date.now(), newest + 1);
    // A break is four slow landings among fast ones: over the p90 budget, within the p50 budget.
    for (let n = 0; n < window; n++) {
      const toMain = mode === 'break' && n >= window - 4 ? 70 : 10;
      events.push(
        ...(await applyLandingSample(ctx, projectId, {
          at: start + n,
          id: `drill${String(n).padStart(4, '0')}`,
          toMain,
          check: 1,
          settle: 1,
          attempts: 1,
          writes: 7,
          stages: { queue: toMain - 2, check: 1, settle: 1 },
        })),
      );
    }
    return canonicalPayload({
      original: row?.value ?? null,
      events: events.map(e => `${e.kind} ${e.budget.id} ${e.value}`),
    });
  },
});
