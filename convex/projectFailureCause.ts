// SPDX-License-Identifier: Apache-2.0
// The Failed check screen's one read (Items b030c3c5 and 2c420916): a Lane's newest landing, its check run summary
// and the failure cause from src/check-failure-cause.ts. A subscription; it re-runs only when one of the rows it read
// is written, so an idle or settled page costs nothing.
import { v } from 'convex/values';
import { z } from 'zod';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { loadLanding } from './projectHostedLandingStore';
import { readHostedRecord } from './projectHostedRecords';
import {
  causeFrom,
  landingRun,
  laneLandingRequest,
  laneOverlap,
  lanePaths,
  mainEvidence,
} from './projectFailureCauseRead';
import { report } from './errors';
import { landingStateOf, type LandingStateName } from '../src/landing-state';
import { landingSpeedStateSchema, speedWindow } from '../src/landing-speed-alerts';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import type { QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { landingOrderWaitForReader } from './projectHostedLandingOrder';

const intentTitle = z.looseObject({ outcome: z.string() });
/** States where the check has not answered yet, so the screen says when it usually does. */
const unanswered = new Set<LandingStateName>(['queued', 'waiting-for-runner', 'checking']);
/** The median check time needs at least this many settled landings; fewer is "not reported". */
export const EXPECTED_MIN_SAMPLES = 3;

/** The project's recent check minutes, from the landing-speed window it already keeps (src/landing-speed-alerts.ts:
 * check minutes, from the check's reservation to its result, of up to the last 40 landings). One indexed read of a row
 * of about 3.7 KB, written once per settled landing. */
async function checkSamples(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const parsed = row ? landingSpeedStateSchema.safeParse(JSON.parse(row.value)) : null;
  return parsed?.success ? speedWindow(parsed.data.samples) : [];
}
/** The project's usual check time (the median), as the check screen says it. Null when fewer than
 * EXPECTED_MIN_SAMPLES landings reported a check time. */
async function expectedCheck(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  return expectedFromSamples(await checkSamples(ctx, projectId));
}
/** The usual (p50) and usual slowest (p90) check seconds, for the Lanes page's checking rows (Item ecd6e610). The
 * window does not record scoped and full checks apart, so both are over every recent check. */
export async function usualCheck(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  return usualFromSamples(await checkSamples(ctx, projectId));
}
/** Median and p90 (nearest rank) check seconds of the samples that reported one. Pure. */
export function usualFromSamples(samples: readonly (readonly unknown[])[]) {
  const minutes = samples
    .map(sample => sample[2])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (minutes.length < EXPECTED_MIN_SAMPLES) return null;
  const middle = minutes.length >> 1;
  const median = minutes.length % 2 ? minutes[middle]! : (minutes[middle - 1]! + minutes[middle]!) / 2;
  const slow = minutes[Math.ceil(minutes.length * 0.9) - 1]!;
  return { seconds: Math.round(median * 60), slowSeconds: Math.round(slow * 60), landings: minutes.length };
}
/** Median check seconds of the samples that reported one. Pure. */
export function expectedFromSamples(samples: readonly (readonly unknown[])[]) {
  const usual = usualFromSamples(samples);
  return usual && { seconds: usual.seconds, landings: usual.landings };
}

/**
 * Budget per view (stated for b030c3c5): 1 query execution. Reads, all by index: project access (2), the Lane's
 * overlap row (1), its intent (2), the newest compose selection and its row (2), the newest landing request,
 * its state and attempt (3), the check run (1), main's audit row (1), and only for a failed run that names no
 * test file the run's job summaries (at most 64). While the check has not answered (queued, waiting for a runner,
 * checking), the landing-speed row (1, about 3.7 KB), which re-runs an open page once per landing in the project.
 * No writes, no scheduler, no log fetch, no polling.
 */
export const forLane = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read a landing check.');
      await accessibleProject(ctx, projectId, user.subject);
      const overlap = await laneOverlap(ctx, projectId, laneId);
      const intent = overlap
        ? await readHostedRecord(ctx, {
            projectId,
            actor: user.subject,
            kind: 'intent',
            key: overlap.intentId,
          })
        : null;
      const title = intent ? (intentTitle.safeParse(JSON.parse(intent.value)).data?.outcome ?? null) : null;
      const { count, lane } = lanePaths(overlap);
      const { candidateId, request } = await laneLandingRequest(ctx, projectId, laneId);
      const main = await mainEvidence(ctx, projectId);
      if (!request)
        return canonicalPayload({
          laneId,
          title,
          candidateId,
          landing: null,
          run: null,
          cause: null,
          main,
          lane: lane ? { count: count!, complete: lane.complete } : null,
          expected: null,
        });
      const { state, row } = await loadLanding(ctx, { projectId, submissionId: request.submissionId });
      const { summary, step, reDefers } = await landingRun(ctx, projectId, row, state);
      // A passed entry parked behind an older one names it, from the row in hand (43b51a5e).
      const landing = landingStateOf({ ...state, orderWait: landingOrderWaitForReader(row, state) }, laneId);
      const cause = causeFrom({ state, laneId, summary, step, lane, main, reDefers });
      const expected = unanswered.has(landing.state) ? await expectedCheck(ctx, projectId) : null;
      return canonicalPayload({
        laneId,
        title,
        candidateId,
        landing: {
          submissionId: state.id,
          operationId: request.operationId,
          phase: state.phase,
          state: landing.state,
          label: landing.label,
          nextStep: landing.nextStep,
          at: state.at,
          retryReason: state.retryReason ?? null,
          error: state.error ? { code: state.error.code, message: state.error.message.slice(0, 600) } : null,
          receiptId: state.acceptance?.receiptId ?? null,
        },
        run: summary,
        cause,
        main,
        lane: lane ? { count: count!, complete: lane.complete } : null,
        expected,
      });
    } catch (error) {
      return report(error);
    }
  },
});
