// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import {
  landingSpeedAlertMessage,
  landingSpeedSample,
  landingSpeedStateSchema,
  observeLandingSpeed,
  type LandingSpeedState,
} from '../src/landing-speed-alerts';

/** Rung 1 of the regression ladder, inside the mutation that lands: one indexed read and one
 * write of a row of at most ~10 KB; no new Convex call. An alert (at most one per metric per
 * day) reads the project and schedules the existing stall-alert delivery to the owner's channels. */
export async function recordLandingSpeed(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
) {
  const sample = landingSpeedSample(state);
  if (!sample) return [];
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  // A metric never fails a landing: an unreadable row starts a fresh window.
  let previous: LandingSpeedState | null;
  try {
    previous = row ? landingSpeedStateSchema.parse(JSON.parse(row.value)) : null;
  } catch {
    previous = null;
  }
  const { state: next, alerts } = observeLandingSpeed(previous, sample);
  const value = canonicalPayload(next);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert('projectLandingSpeed', { projectId, value });
  if (!alerts.length) return alerts;
  const project = await ctx.db.get(projectId);
  if (!project) return alerts;
  const settings = effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;
  if (settings.enabled)
    for (const alert of alerts)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectHostedLandingStallAlert:deliver'),
        {
          ...landingSpeedAlertMessage(alert, project.name),
          settings: canonicalPayload(settings),
        },
      );
  return alerts;
}
