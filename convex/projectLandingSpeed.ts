// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { MutationCtx } from './_generated/server';
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
  speedBudgetMessage,
  type LandingSpeedState,
} from '../src/landing-speed-alerts';
import { speedBudgets } from '../src/speed-budgets';

/** Speed and cost budgets, judged inside the mutation that lands: one indexed read and one write of a
 * row of about 3.5 KB; no new Convex call. `attempts` is the accepted attempt's ordinal plus one, from
 * the attempt the caller already loaded. Only a budget that breaks or recovers (rare, never while it
 * stays broken) reads the project and schedules the existing stall-alert delivery plus one Issue write. */
export async function recordLandingSpeed(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
  attempts: number | null = null,
) {
  const sample = landingSpeedSample(state, attempts);
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
  if (!events.length) return events;
  const project = await ctx.db.get(projectId);
  if (!project) return events;
  const settings = effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;
  for (const event of events) {
    // The Issue is the durable record, so it is written whether or not owner channels are on.
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
