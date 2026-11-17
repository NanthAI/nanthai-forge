// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import {
  hostedLandingStateSchema,
  type HostedLandingAttempt,
  type HostedLandingRequest,
} from '../src/hosted-landing';
import { preQueueCheck } from '../src/hosted-landing-admission';
import { hostedBatching } from '../src/hosted-landing-batch';
import { globalRiskBetween } from '../src/first-check-risk';
import { pathsOverlap } from '../src/hosted-cross-head-proof';
import { placeableRisk } from '../src/package-placement';
import { canonicalPayload } from '../src/hosted-source-operation';
import { pipelinePredecessor } from './projectHostedLandingPipeline';
import type { LandingRow } from './projectHostedLandingStore';
import { landingChangedPaths } from './projectHostedLandingOvertake';

/** A solo pass cannot carry an overlapping or global-risk interaction. Use the existing exact
 * predicted-head train instead of first spending a run on a tree that cannot
 * land. The predecessor still owns its admission; its failure, hold or re-pin
 * invalidates descendants through the ordinary pipeline. No new check or wake. */
export async function pipelineAdmission(
  ctx: MutationCtx,
  input: {
    project: Doc<'hostedProjects'>;
    attempt: HostedLandingAttempt;
    request: HostedLandingRequest;
    paths: string[] | null;
    queue: Doc<'projectHostedLandingQueues'>;
  },
) {
  const { project, attempt, request, paths, queue } = input;
  const fast = attempt.policy.acceptance.landingMode === 'fast';
  if (
    !paths?.length ||
    !project.checkEntries ||
    !attempt.deferredCheck ||
    !preQueueCheck(attempt.policy) ||
    !hostedBatching(attempt.policy) ||
    request.check?.kind !== 'request' ||
    request.finish?.after ||
    (fast && !queue.train?.length && !queue.status?.runningGroups) ||
    attempt.policy.acceptance.hostedCrossHeadReuse === false
  )
    return null;
  const [seed] = queue.train?.length
    ? []
    : fast
      ? await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_orderLive_and_sequence', q =>
            q.eq('projectId', project._id).eq('channel', 'main').eq('orderLive', true),
          )
          .order('asc')
          .take(1)
      : await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_admitting_and_sequence', q =>
            q.eq('projectId', project._id).eq('channel', 'main').eq('admitting', true),
          )
          .order('asc')
          .take(1);
  if (!queue.train?.length && !seed) return null;
  const selected: { row?: LandingRow; attempt?: HostedLandingAttempt } = {};
  let full = false;
  const predecessor = await pipelinePredecessor(
    ctx,
    { projectId: project._id, channel: 'main' },
    seed ? [seed] : undefined,
    (row, pins) => {
      selected.row = row;
      selected.attempt = pins;
    },
    {
      queue,
      requireSlot: false,
      onCapacity: value => {
        full = value;
      },
    },
  );
  if (!predecessor || !selected.row || !selected.attempt) return null;
  const prior = { row: selected.row, state: hostedLandingStateSchema.parse(JSON.parse(selected.row.value)) };
  const pins = selected.attempt;
  if (
    prior.state.priority !== (request.priority ?? 'normal') ||
    pins.actor.id !== attempt.actor.id ||
    pins.authorityEpoch !== attempt.authorityEpoch ||
    pins.policyDigest !== attempt.policyDigest ||
    canonicalPayload(prior.state.request.check) !== canonicalPayload(request.check)
  )
    return null;
  const earlier = await landingChangedPaths(ctx, prior.row, prior.state);
  const entries = [...project.checkEntries, ...(project.globalRiskPaths ?? [])];
  if (!earlier?.length) return null;
  if (pathsOverlap(paths, earlier)) return prior.row.orderLive === true ? predecessor.submissionId : null;
  return !fast &&
    !full &&
    globalRiskBetween(paths, earlier, entries) &&
    !placeableRisk(paths, earlier, entries)
    ? predecessor.submissionId
    : null;
}
