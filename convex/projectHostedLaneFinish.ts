// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { composeRow, composeStateSchema } from './projectHostedComposeStore';
import { landingRow } from './projectHostedLandingStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { syncRequiredAdvice } from '../src/hosted-would-conflict';

/** Newest compositions of one Lane that can still hold a live finish. */
const RECENT_COMPOSITIONS = 8;
const LIVE = new Set(['composing', 'queued', 'checking', 'ready']);

/** The live finish that a new head for this Lane would silently supersede, or
 * null. Reverse lookup rides the compose selections (no backfill): at most
 * RECENT_COMPOSITIONS selections, each one compose row, one landing query and
 * one desired-landing query. A finish composed before the Lane's current head
 * was written is already doomed, so it does not count. */
export async function liveLaneFinish(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; headWrittenAt: string },
  /** Withdraw also selects a queued entry marked wouldConflict: it still holds a queue place. */
  options: { queuedConflicts?: true } = {},
) {
  return (await laneFinishes(ctx, input, options)).live;
}

/** The same bounded lookup, also naming the Lane's queued entries that need a sync (accepted-main
 * wouldConflict, not yet checked). They do not block a save: the save that moves the head
 * supersedes them in its own transaction (f7539ebb item 5). Collection stops at the first live
 * finish, which refuses the save unless it supersedes on purpose. */
export async function laneFinishes(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; headWrittenAt: string },
  options: { queuedConflicts?: true } = {},
) {
  const syncRequired: string[] = [];
  const selections = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.laneId),
    )
    .order('desc')
    .take(RECENT_COMPOSITIONS);
  for (const selection of selections) {
    const compose = await composeRow(ctx, selection);
    if (!compose) continue;
    const { candidateId } = composeStateSchema.parse(JSON.parse(compose.value));
    const requests = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_candidate_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('candidateId', candidateId),
      )
      .order('desc')
      .take(3);
    const [desired] = requests.length
      ? []
      : await ctx.db
          .query('projectHostedLandingDesired')
          .withIndex('by_project_and_compose', q =>
            q.eq('projectId', input.projectId).eq('composeOperationId', selection.operationId),
          )
          .take(1);
    for (const row of requests)
      if (
        row.wouldConflict &&
        row.phase === 'queued' &&
        syncRequiredAdvice(JSON.parse(row.wouldConflict)) &&
        !syncRequired.includes(row.submissionId)
      )
        syncRequired.push(row.submissionId);
    const rows = [
      // A queued entry marked wouldConflict is replaced in place by the Lane's next land (sync + save).
      ...requests.filter(row => options.queuedConflicts || !row.wouldConflict).map(row => row.value),
      ...(desired && !(await landingRow(ctx, desired)) ? [desired.value] : []),
    ];
    for (const value of rows) {
      const state = hostedLandingStateSchema.parse(JSON.parse(value));
      const composedAt = state.timing?.composeStartedAt ?? state.at;
      if (LIVE.has(state.phase) && composedAt >= input.headWrittenAt)
        return { live: { submissionId: state.id, phase: state.phase, state }, syncRequired };
    }
  }
  return { live: null, syncRequired };
}

export const laneFinishActiveMessage = (laneId: string, finish: { submissionId: string; phase: string }) =>
  `Lane ${laneId} has an active finish (submission ${finish.submissionId}, ${finish.phase}). ` +
  'Saving new changes now would supersede it and throw away its checks. Wait for it to land or fail, ' +
  'then save again. If you know its check will fail, end it with land --withdraw, then save and land again. ' +
  'To replace it on purpose, save with supersedeFinish:true.';

export async function refuseLiveLaneFinish(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; headWrittenAt: string },
) {
  const finish = await liveLaneFinish(ctx, input);
  invariant(!finish, 'LANE_FINISH_ACTIVE', finish ? laneFinishActiveMessage(input.laneId, finish) : '');
}

/** A new head of the Lane (save or sync) ends its queued entries that need a sync in the same
 * transaction (f7539ebb item 5): they were composed from the old head and can no longer be accepted,
 * so leaving them queued only strands a queue place. Each ends LANDING_SUPERSEDED through the
 * cancellation path (peers reselected, finish IO fenced, queue released). Bounded by the lookup:
 * at most RECENT_COMPOSITIONS * 3 entries; nothing runs when none is marked. */
export async function supersedeSyncRequired(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; head: string; submissionIds?: string[] },
) {
  const ids =
    input.submissionIds ??
    (await laneFinishes(ctx, { ...input, headWrittenAt: '' }, { queuedConflicts: true })).syncRequired;
  const superseded: string[] = [];
  for (const submissionId of ids) {
    const row = await landingRow(ctx, { projectId: input.projectId, submissionId });
    if (!row || row.phase !== 'queued' || !row.wouldConflict) continue;
    if (!syncRequiredAdvice(JSON.parse(row.wouldConflict))) continue;
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    // Read-only precondition: an entry whose attempt is unreadable keeps today's path (it ends
    // LANDING_SUPERSEDED at acceptance), so this can never fail the save that moved the head.
    const attempt = await loadLandingAttempt(ctx, {
      projectId: input.projectId,
      attemptId: state.attemptId,
    }).catch(() => null);
    if (!attempt) continue;
    await cancelHostedLanding(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      supersede: { laneId: input.laneId, head: input.head },
      request: {
        operationId: crypto.randomUUID(),
        authorityEpoch: state.request.authorityEpoch,
        submissionId,
      },
      reason: `Superseded by Lane ${input.laneId} head ${input.head}: main had changed files this queued entry changes, and the Lane moved on. Its next land --save carries this work; nothing else is needed.`,
    });
    superseded.push(submissionId);
  }
  return superseded;
}
