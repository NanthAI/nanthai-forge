// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { composeRow, composeStateSchema } from './projectHostedComposeStore';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { liveOwner } from './projectHostedLandingStall';
import { redriveLanding } from './projectHostedLandingRedrive';
import type { LandingRow } from './projectHostedLandingStore';
import { landingRow } from './projectHostedLandingStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { storedLandingStateSchema } from '../src/hosted-landing';
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
  options: { queuedConflicts?: true; all?: true; head?: string; exactOrigin?: true } = {},
) {
  const liveSubmissions: string[] = [];
  let live: {
    submissionId: string;
    phase: string;
    state: ReturnType<typeof storedLandingStateSchema.parse>;
  } | null = null;
  const syncRequired: string[] = [];
  const selections = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.laneId),
    )
    .order('desc')
    .take(RECENT_COMPOSITIONS);
  for (const selection of selections) {
    if (options.head && (options.exactOrigin || selection.head) && selection.head !== options.head) continue;
    const compose = await composeRow(ctx, selection);
    if (!compose) continue;
    const { candidateId, request } = composeStateSchema.parse(JSON.parse(compose.value));
    // Only this Lane's pinned source moves to the draft. Keep aggregate work in the queue.
    if (options.exactOrigin && (request.inputs.count !== 1 || request.dependencies.count !== 0)) continue;
    const requests = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_candidate_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('candidateId', candidateId),
      )
      .order('desc')
      .take(3);
    const desiredCount = options.all
      ? Math.max(0, 3 - requests.filter(row => LIVE.has(row.phase)).length)
      : requests.length
        ? 0
        : 1;
    const desired = desiredCount
      ? await ctx.db
          .query('projectHostedLandingDesired')
          .withIndex('by_project_and_compose', q =>
            q.eq('projectId', input.projectId).eq('composeOperationId', selection.operationId),
          )
          .order('desc')
          .take(desiredCount)
      : [];
    const preparing: string[] = [];
    for (const row of desired)
      if (
        !requests.some(request => request.submissionId === row.submissionId) &&
        !(await landingRow(ctx, row))
      )
        preparing.push(row.value);
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
      ...preparing,
    ];
    for (const value of rows) {
      const state = storedLandingStateSchema.parse(JSON.parse(value));
      const composedAt = state.timing?.composeStartedAt ?? state.at;
      if (LIVE.has(state.phase) && composedAt >= input.headWrittenAt) {
        live ??= { submissionId: state.id, phase: state.phase, state };
        if (!liveSubmissions.includes(state.id)) liveSubmissions.push(state.id);
        if (!options.all) return { live, syncRequired, liveSubmissions };
      }
    }
  }
  return { live, syncRequired, liveSubmissions };
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

/** A save, sync or resolution handoff ends the superseded head's queued entries that need a sync in
 * the same transaction. Leaving them queued only strands a queue place. Each ends LANDING_SUPERSEDED through the
 * cancellation path (peers reselected, finish IO fenced, queue released). Bounded by the lookup:
 * at most RECENT_COMPOSITIONS * 3 entries; nothing runs when none is marked.
 * A conflict handoff uses the origin for lookup and the resolution Lane for the receipt. */
export async function supersedeLaneFinishes(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId: string;
    head: string;
    replacementLaneId?: string;
    submissionIds?: string[];
    scope?: 'live' | 'handoff';
    fromHead?: string;
  },
) {
  const found = input.submissionIds
    ? null
    : await laneFinishes(
        ctx,
        { ...input, headWrittenAt: '' },
        {
          queuedConflicts: true,
          all: true,
          ...(input.fromHead ? { head: input.fromHead } : {}),
          ...(input.scope === 'handoff' ? { exactOrigin: true } : {}),
        },
      );
  const ids = input.submissionIds ?? (input.scope === 'live' ? found!.liveSubmissions : found!.syncRequired);
  const replacement = { laneId: input.replacementLaneId ?? input.laneId, head: input.head };
  const superseded: string[] = [];
  for (const submissionId of ids) {
    const key = { projectId: input.projectId, submissionId };
    const row = await landingRow(ctx, key);
    if (!row && input.scope === 'live') {
      const desired = await desiredLanding(ctx, key);
      const state = desired && storedLandingStateSchema.parse(JSON.parse(desired.value));
      if (state && LIVE.has(state.phase)) {
        await cancelHostedLanding(ctx, {
          projectId: input.projectId,
          actor: state.actor,
          supersede: replacement,
          replacementCause: { kind: 'new-save', link: replacement.head },
          request: {
            operationId: crypto.randomUUID(),
            authorityEpoch: state.request.authorityEpoch,
            submissionId,
          },
          reason: `Superseded by Lane ${replacement.laneId} head ${replacement.head}: the original source preparation continues in its resolution.`,
        });
        superseded.push(submissionId);
      }
      continue;
    }
    if (!row || !LIVE.has(row.phase)) continue;
    if (
      input.scope !== 'live' &&
      (row.phase !== 'queued' || !row.wouldConflict || !syncRequiredAdvice(JSON.parse(row.wouldConflict)))
    )
      continue;
    const state = storedLandingStateSchema.parse(JSON.parse(row.value));
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
      supersede: replacement,
      replacementCause: { kind: 'new-save', link: replacement.head },
      request: {
        operationId: crypto.randomUUID(),
        authorityEpoch: state.request.authorityEpoch,
        submissionId,
      },
      reason: `Superseded by Lane ${replacement.laneId} head ${replacement.head}: this work continues in a newer resolution or landing. The original source and checks remain retained.`,
    });
    superseded.push(submissionId);
  }
  return superseded;
}

/** A new request may join only work that still has an owner. Read-only lost-driver probing
 * preserves an in-flight IO fence; ordinary lost queue steps are replayed when an owner remains. */
export async function replaceOwnerlessLanding(ctx: MutationCtx, row: LandingRow) {
  const state = storedLandingStateSchema.parse(JSON.parse(row.value));
  if (!LIVE.has(state.phase)) return false;
  const input = { projectId: row.projectId, submissionId: row.submissionId };
  const lost = await redriveLanding(ctx, input, { row, probe: true });
  if (state.phase !== 'queued') {
    if (lost.length) await redriveLanding(ctx, input, { row });
    return false;
  }
  if (await liveOwner(ctx, input, row, state)) {
    if (lost.length) await redriveLanding(ctx, input, { row });
    return false;
  }
  const attempt = await loadLandingAttempt(ctx, { projectId: row.projectId, attemptId: state.attemptId });
  const composeId = state.request.finish?.composeOperationId;
  const [selection] = composeId
    ? await ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
          q
            .eq('projectId', row.projectId)
            .eq('actor', state.actor)
            .eq('operationId', composeId)
            .eq('kind', 'inputs'),
        )
        .take(1)
    : [];
  if (!selection) return false;
  await cancelHostedLanding(ctx, {
    projectId: row.projectId,
    actor: state.actor,
    supersede: { laneId: selection.key, head: selection.head ?? attempt.candidate.head ?? '' },
    // A driver-lost retry, not a new save: an explicit code keeps it countable (ced8e98f).
    replacementCause: { kind: 'unknown', link: 'LANDING_DRIVER_LOST_RETRY' },
    request: {
      operationId: crypto.randomUUID(),
      authorityEpoch: state.request.authorityEpoch,
      submissionId: state.id,
    },
    reason:
      'The retry replaces a queued landing whose driver was lost. Its source and attempts remain retained.',
  });
  return true;
}
