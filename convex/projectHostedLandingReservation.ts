// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingRow } from './projectHostedLandingStore';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { landingChangedPaths } from './projectHostedLandingOvertake';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { landingReservation, reservationHolds } from '../src/landing-reservation';

/** Landing reservations (Issue 10d253c6; rules in src/landing-reservation.ts). A submission
 * takes its Candidate's Intent from the pin that already read the Candidate, reads the Intent's
 * previous landing (one indexed row) and stores the count and the reservation end on its own new
 * row: no extra write. */
export async function submissionReservation(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; intentId: string | undefined },
  now: number,
) {
  const { intentId } = input;
  if (!intentId) return {};
  const [prior] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_intent', q => q.eq('projectId', input.projectId).eq('intentId', intentId))
    .order('desc')
    .take(1);
  const value = prior ? hostedLandingStateSchema.parse(JSON.parse(prior.value)) : null;
  const granted = landingReservation(
    prior && value
      ? {
          phase: prior.phase,
          errorCode: value.error?.code ?? null,
          checkPassed: prior.admission?.status === 'passed' || value.timing?.ciEndedAt !== undefined,
          ...(prior.superseded !== undefined ? { superseded: prior.superseded } : {}),
        }
      : null,
    now,
  );
  return {
    intentId,
    ...(granted.superseded ? { superseded: granted.superseded } : {}),
    ...(granted.until !== null ? { reservedUntil: granted.until } : {}),
  };
}

/** A landing's changed paths for reservation matching: its own Candidate's, or for a combined
 * group every member's (one batch read and one record read per member). Null when unknown. */
async function changedPaths(ctx: QueryCtx | MutationCtx, row: LandingRow, state: HostedLandingState) {
  if (!state.batchId || state.batchSolo) return landingChangedPaths(ctx, row, state);
  const batch = await batchRow(ctx, { projectId: row.projectId, batchId: state.batchId });
  if (!batch) return null;
  const paths: string[] = [];
  for (const member of batchSchema.parse(JSON.parse(batch.value)).members) {
    const own = await landingChangedPaths(
      ctx,
      { projectId: row.projectId, actor: member.actor.id },
      {
        ...state,
        request: { ...state.request, candidateId: member.candidate.id },
      },
    );
    if (!own) return null;
    paths.push(...own);
  }
  return paths;
}

/** Live reservations on this Channel, oldest grant first: one indexed window. */
async function liveReservations(ctx: QueryCtx | MutationCtx, row: LandingRow, now: number) {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_reservedUntil', q =>
      q.eq('projectId', row.projectId).eq('channel', row.channel).gt('reservedUntil', now),
    )
    .take(8);
  // A holder that already landed or failed holds nothing, even if a write path left its end set.
  return rows
    .filter(
      other =>
        other.submissionId !== row.submissionId &&
        other.phase !== 'landed' &&
        other.phase !== 'terminal-failed',
    )
    .sort((a, b) => a._creationTime - b._creationTime);
}

/** The reservation this passed landing must wait for before it takes main, or null. No read
 * past the one indexed window while no reservation is live; paths are read only then. */
export async function reservationAhead(
  ctx: QueryCtx | MutationCtx,
  row: LandingRow,
  state: HostedLandingState,
  now: number,
) {
  if (row.priority === 'urgent') return null;
  const holders = await liveReservations(ctx, row, now);
  if (!holders.length) return null;
  let mine: string[] | null | undefined;
  for (const holder of holders) {
    const value = hostedLandingStateSchema.parse(JSON.parse(holder.value));
    if (value.observation.pendingReason === 'waiting-for-review') continue;
    const grantedAt = holder._creationTime,
      reservedAt = row.reservedUntil !== undefined ? row._creationTime : undefined;
    // Cheap rules first: a later grant, an expired one or the same group never holds.
    if (
      !reservationHolds(
        { until: holder.reservedUntil!, grantedAt, paths: null, batchId: value.batchId },
        { paths: null, priority: row.priority, reservedAt, batchId: state.batchId },
        now,
      )
    )
      continue;
    if (mine === undefined) mine = await changedPaths(ctx, row, state);
    const theirs = await landingChangedPaths(ctx, holder, value);
    if (
      reservationHolds(
        { until: holder.reservedUntil!, grantedAt, paths: theirs, batchId: value.batchId },
        { paths: mine, priority: row.priority, reservedAt, batchId: state.batchId },
        now,
      )
    )
      return {
        row: holder,
        state: value,
        held: 'reserved' as const,
        footprints: theirs && mine ? ('overlap' as const) : ('unknown' as const),
        until: holder.reservedUntil!,
      };
  }
  return null;
}

/** A reservation holder takes main ahead of an older entry its reservation holds back (that
 * entry waits for it), so the two never wait for each other. One record read per older entry,
 * only for a holder with a live reservation. */
export async function heldBackByReservation(
  ctx: QueryCtx | MutationCtx,
  holder: { row: LandingRow; state: HostedLandingState; paths: () => Promise<string[] | null> },
  other: LandingRow,
  value: HostedLandingState,
  now: number,
) {
  if (holder.row.reservedUntil === undefined) return false;
  return reservationHolds(
    {
      until: holder.row.reservedUntil,
      grantedAt: holder.row._creationTime,
      paths: await holder.paths(),
      batchId: holder.state.batchId,
    },
    {
      paths: await changedPaths(ctx, other, value),
      priority: other.priority,
      reservedAt: other.reservedUntil !== undefined ? other._creationTime : undefined,
      batchId: value.batchId,
    },
    now,
  );
}

/** Status for readers, from the row already loaded: no extra read. */
export function landingReservationForReader(
  row: Pick<LandingRow, 'reservedUntil' | 'superseded' | 'phase'> | null | undefined,
  now = Date.now(),
) {
  if (!row?.reservedUntil || row.phase === 'landed' || row.phase === 'terminal-failed') return null;
  const live = row.reservedUntil > now;
  return {
    until: new Date(row.reservedUntil).toISOString(),
    live,
    superseded: row.superseded ?? 0,
    message: live
      ? `Reserved until ${new Date(row.reservedUntil).toISOString()}: this landing was superseded after a passed check, so landings that change its files wait for it (or for that time) before taking main.`
      : 'Reservation ended at its time bound; this landing takes its ordinary turn.',
  };
}
