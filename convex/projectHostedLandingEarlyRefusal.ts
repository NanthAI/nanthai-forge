// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { landingQueue, landingRow, loadLandingAttempt, type LandingRow } from './projectHostedLandingStore';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { hostedStartMain } from './projectHostedChannels';
import {
  hostedLandingStateSchema,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import { hostedBatching } from '../src/hosted-landing-batch';
import { cohortSize, preQueueCheck } from '../src/hosted-landing-admission';
import { wakeLandingOrderWaiters } from './projectHostedFinishWake';

/** Older entries read in one window, as `olderLandingAhead`. A full window keeps
 * the ordinary path: this never pages the queue. */
export const EARLY_REFUSAL_WINDOW = 16;
type Main = { head: string; receipt: { id: string } };

/** A READY entry bound to its own pre-queue Lane run on a main that has moved since.
 * A bound attempt carries no conservative-impact proof, so publication must refuse
 * it (CHANNEL_CHANGED); only its turn in the order is left to wait for. */
export function staleLaneProof(
  row: Pick<LandingRow, 'admission'>,
  state: HostedLandingState,
  attempt: HostedLandingAttempt,
  main: Main,
) {
  const admission = row.admission;
  return (
    state.phase === 'ready' &&
    !state.batchId &&
    !state.batchSolo &&
    admission?.full === true &&
    admission.status === 'passed' &&
    admission.reuse === 'tried' &&
    attempt.check?.runId === admission.runId &&
    !attempt.crossHeadProof &&
    (attempt.main.head !== main.head || attempt.main.receiptId !== main.receipt.id)
  );
}

/** An entry that early refusal can treat as a refused peer: an admitted change
 * that tried its Lane run and is still READY on it, or is recomposing after its
 * refusal (queued, batchable, no run of its own). Row fields only, no reads. */
function refusablePeer(other: LandingRow) {
  const admission = other.admission;
  if (other.priority === 'urgent' || !admission?.full || admission.status !== 'passed') return false;
  if (admission.reuse !== 'tried') return false;
  if (other.phase === 'ready') return other.runId === admission.runId;
  return other.phase === 'queued' && other.batchable && !other.runId;
}
/** Refuse a certainly stale Lane proof now instead of at its turn (wave 3b,
 * 2026-11-05: refused changes recomposed one after another, 558 -> 559 -> 560 ->
 * 563, 4.3 minutes before their one cohort formed). Only while every older entry
 * holding order is itself refused or stale and will join the same cohort on
 * current main, and nothing retained can move main first: no new check, no
 * speculative stack and no second recomposition, the same one refusal earlier.
 * The entry keeps deciding while it recomposes, so the cohort hold collects it.
 * No reads unless the entry it waits for (`waitingOn`, already loaded by the order
 * claim) is itself such a peer, so a wait behind a checking group or train costs
 * nothing. Then: this attempt, main, the queue and its retained train, one
 * indexed window of at most 16 older rows and the attempts of older READY rows.
 * No writes. Returns this entry's cohort position and the cohort size, or null. */
export async function refuseStaleLaneProofNow(
  ctx: MutationCtx,
  selected: { row: LandingRow; state: HostedLandingState; waitingOn: LandingRow },
) {
  const { row, state, waitingOn } = selected;
  const endedAt = row.admission?.endedAt;
  if (
    !refusablePeer(waitingOn) ||
    state.phase !== 'ready' ||
    row.priority === 'urgent' ||
    !row.admission?.full ||
    row.admission.reuse !== 'tried' ||
    endedAt === undefined
  )
    return null;
  const attempt = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const policy = attempt.policy;
  // A READY row is never `batchable` (that flag is for queued work), and a bound
  // Lane proof drops `deferredCheck`; the retained batch selection is what makes
  // it batchable once it recomposes.
  if (
    !row.batchSelection ||
    !preQueueCheck(policy) ||
    !hostedBatching(policy) ||
    policy.acceptance.batchMaxSize === 1
  )
    return null;
  const main = await hostedStartMain(ctx, row.projectId);
  if (!staleLaneProof(row, state, attempt, main)) return null;
  const queue = await landingQueue(ctx, { projectId: row.projectId, channel: 'main' });
  // A retained group (cohort or solo check) can move main before a cohort on
  // current main forms; then the ordinary refusal at its turn stays exact.
  for (const submissionId of queue?.train ?? []) {
    const member = await landingRow(ctx, { projectId: row.projectId, submissionId });
    if (member && member.phase !== 'landed' && member.phase !== 'terminal-failed') return null;
  }
  const older = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_orderLive_and_sequence', q =>
      q
        .eq('projectId', row.projectId)
        .eq('channel', row.channel)
        .eq('orderLive', true)
        .lt('sequence', row.sequence),
    )
    .order('asc')
    .take(EARLY_REFUSAL_WINDOW);
  if (older.length === EARLY_REFUSAL_WINDOW) return null;
  let ahead = 0;
  for (const other of older) {
    const value = hostedLandingStateSchema.parse(JSON.parse(other.value));
    if (!holdsLandingOrder(other, value)) continue;
    if (!refusablePeer(other) || value.batchId || value.batchSolo) return null;
    if (other.phase === 'ready') {
      const its = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: value.attemptId });
      if (!other.batchSelection || !staleLaneProof(other, value, its, main)) return null;
    }
    // One hold per admission: a peer that already held without waiting for this
    // entry may form its cohort before this entry has recomposed.
    const hold = other.admission!.hold;
    if (hold && (hold.done || hold.since < endedAt)) return null;
    ahead++;
  }
  const limit = cohortSize(policy, queue?.checkHistory, true);
  return ahead > 0 && ahead + 1 <= limit ? { position: ahead + 1, limit } : null;
}
/** After a stale Lane proof is refused (at its turn or early), its first order
 * waiter re-evaluates once, so refusals chain in one pass instead of one per
 * recomposition. Only while another member still fits the cohort: the waiter
 * past the limit is not driven. At most one scheduled drive per refusal. */
export async function wakeAfterLaneRefusal(
  ctx: MutationCtx,
  submission: { projectId: LandingRow['projectId']; submissionId: string },
  cohort: { position: number; limit: number },
) {
  if (cohort.position + 1 > cohort.limit) return;
  const row = await landingRow(ctx, submission);
  if (row?.orderWaited) await wakeLandingOrderWaiters(ctx, row);
}
/** The first refusal of a wave happens at publication. Its cohort position is
 * one; the size is read only for an admitted, batchable Lane proof. */
export async function laneRefusalCohort(
  ctx: MutationCtx,
  selected: { row: LandingRow; state: HostedLandingState },
) {
  const { row, state } = selected;
  if (!row.admission?.full || row.admission.reuse !== 'tried' || state.batchId || state.batchSolo)
    return null;
  const attempt = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  if (!row.batchSelection || attempt.check?.runId !== row.admission.runId || attempt.crossHeadProof)
    return null;
  if (!preQueueCheck(attempt.policy) || !hostedBatching(attempt.policy)) return null;
  const queue = await landingQueue(ctx, { projectId: row.projectId, channel: 'main' });
  return { position: 1, limit: cohortSize(attempt.policy, queue?.checkHistory, true) };
}
