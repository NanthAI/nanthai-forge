// SPDX-License-Identifier: Apache-2.0
// Item 0d14c456 (from bf111983 line 4): the environment side of the CI-down hold
// (convex/projectHostedLandingCiDown.ts, switch FORGE_QUEUE_HOLD_ON_CI_DOWN). It reads a failed run's
// environment end, and while the hold is tripped for one check command it parks an entry with that
// check before dispatch, so the fourth identical environment failure never runs. Healthy path: the
// queue row is in hand and `ciDown` is unset, so no read and no write.
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { checkCommandKey, environmentEnd } from '../src/check-environment-failure';
import { landingObservation, type HostedLandingRequest } from '../src/hosted-landing';
import { parkLanding } from './projectHostedLandingPark';
import { leaveTrain } from './projectHostedLandingParkExact';
import { landingQueue } from './projectHostedLandingEvents';
import {
  clearCiDown,
  ciDownTripped,
  holdOnCiDown,
  parkAs,
  type CiDown,
  type Entry,
  type Queue,
} from './projectHostedLandingCiDown';

/** The environment end of a failed run, or null (switch off, a failing test, no environment evidence).
 * Failure path only: one indexed read of the run's sealed output streams (at most 64, the bounded
 * failure summaries checkFailureStep reads too). */
export async function environmentEndOf(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: HostedCheckRun,
) {
  if (!holdOnCiDown() || run.status !== 'failed' || run.cancelRequested) return null;
  const streams = await ctx.db
    .query('projectHostedOutputStreams')
    .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', run.id))
    .take(64);
  return environmentEnd(run, streams.map(sealedSummary));
}
const sealedSummary = (stream: { seal: string | null; failureExcerpt?: string | undefined }) => {
  try {
    const seal = stream.seal ? (JSON.parse(stream.seal) as { failureSummary?: string }) : {};
    return seal.failureSummary || stream.failureExcerpt || '';
  } catch {
    return '';
  }
};

/** Whether a tripped environment hold covers this request's check (same pins). 0 I/O. */
export const heldCommand = (ciDown: CiDown | undefined | null, request: HostedLandingRequest) =>
  holdOnCiDown() &&
  ciDown?.cause === 'environment' &&
  ciDownTripped(ciDown) &&
  request.check?.kind === 'request' &&
  checkCommandKey(request.check) === ciDown.command;

/** Before a queued entry dispatches its check: while an environment hold covers it, it parks with
 * the hold's reason instead (no run), and true. The entry the probe released passes (`probeOpen`).
 * Only an entry outside any cohort line; nothing to do (no read, no write) when `ciDown` is unset. */
export async function holdBeforeDispatch(ctx: MutationCtx, entry: Entry, queue: Queue | null | undefined) {
  const hold = queue?.ciDown;
  if (!queue || !hold || !heldCommand(hold, entry.state.request)) return false;
  const { state } = entry;
  if (state.batchId || state.batchSolo || state.batchOriginId) return false;
  // The probe's released entry checks again; its check's end (or a verdict) closes the permit.
  if (hold.probeOpen === state.id) return false;
  const next = {
    ...state,
    version: state.version + 1,
    phase: 'queued' as const,
    observation: landingObservation('queued'),
    error: parkAs(hold).error,
  };
  await parkLanding(ctx, entry.row, next, 'ci-down');
  await leaveTrain(ctx, [{ row: entry.row, state: next }]);
  return true;
}

/** A saved check definition or runner configuration ends an environment hold (its resume step): the
 * held landings go back to the queue. A landing pinned to the old settings then asks to land again,
 * as any queued landing does after a settings change. An infrastructure hold is left to its probe. */
export async function clearCiDownOnSettingChange(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (queue?.ciDown?.cause === 'environment') await clearCiDown(ctx, queue);
}
