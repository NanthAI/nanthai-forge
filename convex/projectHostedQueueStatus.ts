import { hostedCheckTerminal, hostedCheckRunSchema } from '../src/hosted-check';
import { hostedLandingStall } from '../src/hosted-landing-stall';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { latestLandingProgress, LANDING_STALL_MS } from '../src/landing-stall';
import { queueStatusPage, type QueueStatusKey, type HostedQueueStatus } from '../src/hosted-queue-status';

// Leaf readers keep the event projection independent of controller modules.
// Importing Store/Events here would make every committed observation recursive.
const landingQueue = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; channel: 'main' },
) =>
  ctx.db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', input.projectId).eq('channel', input.channel))
    .unique();
const landingRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
const finishRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) =>
  ctx.db
    .query('projectHostedFinishes')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
async function liveCheck(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, runId: string) {
  const row = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', runId))
    .unique();
  return row ? hostedCheckRunSchema.parse(JSON.parse(row.value)) : null;
}

const pageRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, page: number) =>
  ctx.db
    .query('projectHostedLandingQueueStatus')
    .withIndex('by_project_and_page', q => q.eq('projectId', projectId).eq('page', page))
    .unique();
export { retainQueueStatus } from './projectHostedQueueStatusWrite';

/** Two exact directory reads plus one live predecessor. Read cost does not grow
 * with queue length. The caller has already checked current project authority. */
export async function readQueueStatus(
  ctx: QueryCtx | MutationCtx,
  state: HostedLandingState,
  now = Date.now(),
) {
  if (state.observation.state !== 'pending' || state.phase !== 'queued') return null;
  const projectId = state.projectId as Id<'hostedProjects'>;
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (!queue?.status) return null;
  const page = await pageRow(ctx, projectId, queueStatusPage(state.sequence));
  const key = (page ? (JSON.parse(page.value) as QueueStatusKey[]) : []).find(key => key.id === state.id);
  if (!key?.position || !key.group) return null;
  const ahead = key.predecessor ? await landingRow(ctx, { projectId, submissionId: key.predecessor }) : null;
  const predecessor =
    ahead && !['landed', 'terminal-failed'].includes(ahead.phase)
      ? hostedLandingStateSchema.parse(JSON.parse(ahead.value))
      : null;
  const pending = predecessor ? await finishRow(ctx, { projectId, submissionId: predecessor.id }) : null;
  const liveRun =
    predecessor?.phase === 'checking' && ahead?.runId ? await liveCheck(ctx, projectId, ahead.runId) : null;
  const wake = queue.wake ? await ctx.db.system.get(queue.wake.taskId) : null;
  const queueOwned =
    (queue.lease?.until ?? 0) > now ||
    wake?.state.kind === 'inProgress' ||
    (wake?.state.kind === 'pending' && (queue.wake?.at ?? 0) > now - LANDING_STALL_MS);
  // A retained slow-check alarm is advice, not evidence that its still-live
  // runner vanished. Keep the check owner so follower recovery deadlines do
  // not repeatedly redrive the same healthy fallback controllers.
  const owner = predecessor
    ? predecessor.phase === 'checking' && liveRun && !hostedCheckTerminal(liveRun)
      ? 'check runner / landing controller'
      : predecessor.observation.stall
        ? null
        : pending?.composeOperationId &&
            Date.parse(hostedLandingProgressAt(predecessor)) > now - LANDING_STALL_MS
          ? 'source worker / finish controller'
          : queueOwned
            ? 'landing controller'
            : predecessor.phase === 'ready' && pending?.wake && pending.wake.at > now - LANDING_STALL_MS
              ? 'finish controller'
              : null
    : null;
  const lastProgressAt = latestLandingProgress([
    hostedLandingProgressAt(state),
    queue.status.lastProgressAt,
    ...(predecessor ? [hostedLandingProgressAt(predecessor)] : []),
  ]);
  const serviceMs = queue.status.serviceMs ?? 3 * 60_000;
  const elapsed = predecessor?.timing?.selectedAt
    ? Math.max(0, now - Date.parse(predecessor.timing.selectedAt))
    : 0;
  const parallelGroups = Math.max(1, queue.status.runningGroups ?? 0);
  const milliseconds = Math.max(
    0,
    Math.ceil((key.group - 1) / parallelGroups) * serviceMs - Math.min(elapsed, serviceMs),
  );
  const result: HostedQueueStatus = {
    position: key.position,
    total: queue.status.total,
    entriesAhead: key.position - 1,
    groupsAhead: key.group - 1,
    groupCount: queue.status.groups,
    predecessor: predecessor
      ? {
          id: predecessor.id,
          phase: predecessor.phase,
          lastProgressAt: hostedLandingProgressAt(predecessor),
          owner,
          ...(predecessor.batchId ? { batchId: predecessor.batchId } : {}),
        }
      : null,
    lastProgressAt,
    owner: owner ?? (queueOwned ? 'landing controller' : null),
    parallelGroups,
    eta: {
      milliseconds,
      approximate: true,
      basis: queue.status.serviceMs ? 'recent-service' : 'initial-estimate',
    },
    message: `Queued, position ${key.position} of ${queue.status.total}, ${key.position - 1} entries ahead; ETA about ${Math.ceil(milliseconds / 60_000)} min${predecessor ? `; waiting behind ${predecessor.id} (${predecessor.phase})` : ''}.`,
  };
  return result;
}

/** Old alarms cease to apply when the train has moved or a live predecessor
 * owns this wait. Preserve canonical source/error state; only stale advice goes. */
export function queueAwareLandingState(state: HostedLandingState, queue: HostedQueueStatus | null) {
  if (state.phase !== 'queued' || !state.observation.stall || !queue) return state;
  const stall = hostedLandingStall(state, Date.now(), queue);
  const observation = { ...state.observation };
  if (stall) observation.stall = stall;
  else delete observation.stall;
  return { ...state, observation };
}
