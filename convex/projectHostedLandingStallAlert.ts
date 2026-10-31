// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { landingRow } from './projectHostedLandingStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults, effectiveAgentDefaultsSchema } from '../src/agent-parallel-defaults';
import { deliverStallAlert, stallAlert, type StallAlertTier } from '../src/stall-alerts';

const tier = v.union(v.literal(1), v.literal(2));
type Identity = { projectId: Id<'hostedProjects'>; submissionId: string; lastProgressAt: string };
const alerts = (project: Doc<'hostedProjects'>) =>
  effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;

/** Called once when the stall alarm raises a stall: one deadline for tier 1. Tier 1 schedules tier 2.
 * Idle projects schedule nothing; progress makes a pending alert a one-read no-op. */
export async function scheduleStallAlert(ctx: MutationCtx, input: Identity, project: Doc<'hostedProjects'>) {
  const settings = alerts(project);
  if (!settings.enabled) return;
  await scheduleTier(ctx, input, 1, settings.notifyAfterMinutes);
}
async function scheduleTier(ctx: MutationCtx, input: Identity, tier: StallAlertTier, afterMinutes: number) {
  await ctx.scheduler.runAfter(
    Math.max(0, Date.parse(input.lastProgressAt) + afterMinutes * 60_000 - Date.now()),
    makeFunctionReference<'mutation'>('projectHostedLandingStallAlert:alert'),
    { ...input, tier },
  );
}

export const alert = internalMutation({
  args: { projectId: v.id('hostedProjects'), submissionId: v.string(), lastProgressAt: v.string(), tier },
  returns: v.null(),
  handler: async (ctx, input) => {
    await raiseStallAlert(ctx, input);
    return null;
  },
});

/** The latest alert for a stalled landing, for the stuck agent's status read. One indexed read,
 * made only while the landing is stalled; the landing state itself is never rewritten. */
export async function latestStallAlert(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
  state: HostedLandingState,
) {
  const stall = state.observation.stall;
  if (!stall) return undefined;
  const [row] = await ctx.db
    .query('projectHostedStallAlerts')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .order('desc')
    .take(1);
  if (!row || row.lastProgressAt !== stall.lastProgressAt) return undefined;
  const { tier, text, at } = JSON.parse(row.value) as { tier: StallAlertTier; text: string; at: string };
  return { tier, text, at };
}

export async function raiseStallAlert(
  ctx: MutationCtx,
  input: Identity & { tier: StallAlertTier },
  now = Date.now(),
) {
  const canonical = await landingRow(ctx, input);
  const row = canonical ?? (await desiredLanding(ctx, input));
  if (!row) return null;
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
  // Progress, settlement or review since the deadline was set: nothing is stuck any more.
  if (
    state.observation.state !== 'pending' ||
    !state.observation.stall ||
    hostedLandingProgressAt(state) !== input.lastProgressAt
  )
    return null;
  const sent = await ctx.db
    .query('projectHostedStallAlerts')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .order('desc')
    .take(20);
  if (sent.some(item => item.lastProgressAt === input.lastProgressAt && item.tier === input.tier))
    return null;
  const project = await ctx.db.get(input.projectId);
  if (!project) return null;
  const settings = alerts(project);
  if (!settings.enabled) return null;
  const queuedBehind =
    input.tier === 2 && canonical
      ? (
          await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('channel', 'main')
                .eq('runnable', true)
                .gt('sequence', state.sequence),
            )
            .take(50)
        ).length
      : 0;
  const value = stallAlert(state, input.tier, { project: project.name, queuedBehind, now });
  await ctx.db.insert('projectHostedStallAlerts', {
    projectId: input.projectId,
    submissionId: input.submissionId,
    lastProgressAt: input.lastProgressAt,
    tier: input.tier,
    value: canonicalPayload(value),
  });
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedLandingStallAlert:deliver'), {
    subject: value.subject,
    text: value.text,
    settings: canonicalPayload(settings),
  });
  if (input.tier === 1) await scheduleTier(ctx, input, 2, settings.repeatAfterMinutes);
  return value;
}

/** Owner channels. Secrets are read from env here and nowhere else; logs carry statuses only. */
export const deliver = internalAction({
  args: { subject: v.string(), text: v.string(), settings: v.string() },
  returns: v.null(),
  handler: async (_ctx, input) => {
    const settings = effectiveAgentDefaultsSchema.shape.stallAlerts.parse(JSON.parse(input.settings));
    const results = await deliverStallAlert(input, settings, process.env);
    if (results.length) console.log('stall alert delivery', JSON.stringify(results));
    return null;
  },
});
