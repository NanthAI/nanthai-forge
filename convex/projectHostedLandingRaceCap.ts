// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Recompose cap (queue invariant S5, incident 5e3c3a3c): a newer entry the queue raised to urgent after
// MAIN_RACE_CAP main-race re-checks holds strict order while it checks. Without this, older passes kept
// landing during each of its re-checks (30 of 43 recorded post-check holds of 2026-11-21 to 11-23 named
// older movers), because a normal claim gives way only to an urgent entry that is already Ready.
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { landingRow, type LandingRow } from './projectHostedLandingStore';
import type { HostedLandingState } from '../src/hosted-landing';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { waitFootprints, waitsForCapped } from '../src/landing-overtake';
import { holdsLandingOrder } from './projectHostedLandingOrder';
import { stackedBehind, waitsBackOn } from './projectHostedLandingSuffix';
import { landingChangedPaths, overtakingSide } from './projectHostedLandingOvertake';

/** Batch rows a cycle check may read per capped group. */
const CYCLE_READS = 4;

/** The newer capped entry this passed, normal claimant must wait for, or null. No read while the
 * queue lists none (`queue.raceCapped`, kept by writeLanding and an owner's demotion); otherwise one
 * indexed read per listed entry up to the first blocker, and Candidate reads for those checking. A
 * listed entry found ended is pruned here. */
export async function raceCapAhead(
  ctx: MutationCtx,
  queue: Doc<'projectHostedLandingQueues'>,
  row: LandingRow,
  state: HostedLandingState,
  now = Date.now(),
) {
  const listed = queue.raceCapped;
  if (!listed?.length || row.priority === 'urgent') return null;
  let side: Awaited<ReturnType<typeof overtakingSide>> | undefined;
  let ahead = null;
  const ended: string[] = [];
  for (const id of listed) {
    if (ahead) break;
    if (id === row.submissionId) continue;
    const other = await landingRow(ctx, { projectId: row.projectId, submissionId: id }, false);
    if (!other || other.phase === 'landed' || other.phase === 'terminal-failed') {
      ended.push(id);
      continue;
    }
    if (other.sequence <= row.sequence || other.phase !== 'checking' || other.priority !== 'urgent') continue;
    const value = storedLandingStateSchema.parse(JSON.parse(other.value));
    if (state.batchId && value.batchId === state.batchId) continue;
    if (!holdsLandingOrder(other, value, now)) continue;
    // Queue invariant S6: never park on a capped group whose check stacks on this entry or whose
    // waits lead back to it; it could not land first. A solo unbatched check has neither (no read).
    if (
      value.batchId &&
      ((await stackedBehind(ctx, row, state, value)) ||
        (await waitsBackOn(ctx, row, state, other, value, { reads: CYCLE_READS })))
    )
      continue;
    side ??= await overtakingSide(ctx, row, state, await ctx.db.get(row.projectId));
    const theirs = await landingChangedPaths(ctx, other, value);
    const checkEntries = side?.checkEntries ?? [];
    const capped = {
      proofs: Boolean(side?.proofs),
      unsealed: other.unsealed,
      combined: Boolean(value.batchId && !value.batchSolo),
    };
    if (!waitsForCapped(side?.paths ?? null, theirs, checkEntries, capped)) continue;
    ahead = {
      row: other,
      until: null,
      held: 'recompose-cap' as const,
      footprints: side ? waitFootprints(side.paths, theirs, checkEntries) : ('unknown' as const),
    };
  }
  if (ended.length) {
    const next = listed.filter(id => !ended.includes(id));
    await ctx.db.patch(queue._id, { raceCapped: next.length ? next : undefined });
  }
  return ahead;
}
