// SPDX-License-Identifier: Apache-2.0
import { finishReadReader } from './projectFinishReadReader';
import { readWouldConflict } from './projectHostedLandingWouldConflict';
import { readQueueStatus, queueAwareLandingState } from './projectHostedQueueStatus';
import { landingStateForReader } from './projectHostedLandingOrder';
import { hostedQueueAheadSelection } from './projectHostedQueueAhead';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { landingAlias } from './projectHostedLandingIdentity';
import { finishPendingForReader } from '../src/hosted-finish';
import { ConvexError, v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { finishRow } from './projectHostedFinishWake';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { boardWake } from './projectBoardDelivery';

/** Finite selected-request pages. Every page/subscription rechecks current access;
 * neither reading nor reconnecting wakes a controller. Versions are durable offsets,
 * not authorization. An older record without retained versions is resnapshotted. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    nextVersion: v.number(),
    priorityInfo: v.optional(v.literal(1)),
    /** Wait delivery (feature board-wait): the live wait subscription only, never a page drain.
     * Adds `board` when a note reached this Lane's own inbox after the client's cursor. */
    board: v.optional(v.object({ laneId: v.string(), after: v.number() })),
  },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    const payload = await observePage(rawCtx, input);
    if (!input.board) return payload;
    // Board delivery is advisory: it can never fail or change the landing observation.
    const reader = finishReadReader(rawCtx);
    const user = await reader.auth.getUserIdentity();
    const board = user
      ? await boardWake(reader, {
          projectId: input.projectId,
          viewer: user.subject,
          laneId: input.board.laneId,
          after: input.board.after,
        }).catch(() => undefined)
      : undefined;
    return board ? canonicalPayload({ ...JSON.parse(payload), board }) : payload;
  },
});

async function observePage(
  rawCtx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    nextVersion: number;
    priorityInfo?: 1;
  },
) {
  const ctx = finishReadReader(rawCtx);
  let stage = 'authorization',
    phase: string | null = null,
    version: number | null = null;
  let eventCount = 0;
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to observe hosted submissions.');
    const project = await accessibleProject(ctx, input.projectId, user.subject);
    invariant(
      Number.isSafeInteger(input.nextVersion) && input.nextVersion >= 0,
      'BAD_ARGUMENT',
      'Select a submission version.',
    );
    stage = 'operation';
    const rows = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .take(2);
    const alias = rows.length
      ? null
      : await landingAlias(ctx, {
          projectId: input.projectId,
          actor: user.subject,
          operationId: input.operationId,
        });
    if (alias) {
      const canonical = await landingRow(ctx, alias);
      if (canonical) rows.push(canonical);
    }
    const desired = rows.length
      ? null
      : alias
        ? await desiredLanding(ctx, alias)
        : await ctx.db
            .query('projectHostedLandingDesired')
            .withIndex('by_project_and_actor_and_operation', q =>
              q
                .eq('projectId', input.projectId)
                .eq('actor', user.subject)
                .eq('operationId', input.operationId),
            )
            .unique();
    if (!rows.length && desired) {
      stage = 'desired';
      const state = hostedLandingStateSchema.parse(JSON.parse(desired.value));
      return canonicalPayload({
        projectId: input.projectId,
        operationId: input.operationId,
        canonicalOperationId: state.operationId,
        authority: sourceAuthority(project),
        submission: landingStateForReader(state, input.priorityInfo),
        queuePosition: null,
        queue: null,
        queueAheadSelection: await hostedQueueAheadSelection(ctx, state),
        pendingAttempt: null,
        events: [
          {
            submission: landingStateForReader(state, input.priorityInfo),
            pendingAttempt: null,
          },
        ],
        nextVersion: state.version + 1,
        isDone: true,
        resnapshot: true,
      });
    }
    invariant(rows.length === 1 || alias, 'NOT_FOUND', 'Select one hosted landing operation.');
    stage = 'landing';
    const selectedRow = rows[0];
    invariant(selectedRow, 'NOT_FOUND', 'Hosted landing request not found.');
    const state = landingStateFromRow(selectedRow);
    phase = state.phase;
    version = state.version;
    stage = 'queue';
    const queue = await readQueueStatus(finishReadReader(rawCtx, 'owner'), state);
    const wouldConflict = state.phase === 'queued' ? readWouldConflict(selectedRow) : undefined;
    stage = 'finish';
    const finish = await finishRow(ctx, {
      projectId: input.projectId,
      submissionId: state.id,
    });
    const pendingAttempt = finish ? finishPendingForReader(JSON.parse(finish.value).pending) : null;
    const events = [];
    let nextVersion = input.nextVersion,
      resnapshot = false;
    // Exact indexed reads keep both documents and ranges bounded, including gaps
    // in pre-journal history. Never scan unrelated operations or Work/source data.
    stage = 'history';
    for (let n = 0; n < 20 && nextVersion <= state.version; n++) {
      const row = await ctx.db
        .query('projectHostedLandingObservations')
        .withIndex('by_project_and_submission_and_version', q =>
          q.eq('projectId', input.projectId).eq('submissionId', state.id).eq('version', nextVersion),
        )
        .unique();
      if (!row) {
        events.push({
          submission: landingStateForReader(queueAwareLandingState(state, queue), input.priorityInfo),
          pendingAttempt,
          ...(wouldConflict ? { wouldConflict } : {}),
        });
        nextVersion = state.version + 1;
        resnapshot = true;
        break;
      }
      const event = JSON.parse(row.value);
      events.push({
        ...event,
        pendingAttempt: finishPendingForReader(event.pendingAttempt),
        submission: landingStateForReader(
          hostedLandingStateSchema.parse(event.submission),
          input.priorityInfo,
        ),
      });
      nextVersion++;
      eventCount = events.length;
    }
    stage = 'response';
    return canonicalPayload({
      projectId: input.projectId,
      operationId: input.operationId,
      canonicalOperationId: state.operationId,
      authority: sourceAuthority(project),
      submission: landingStateForReader(queueAwareLandingState(state, queue), input.priorityInfo),
      queuePosition: queue?.position ?? null,
      queue,
      ...(wouldConflict ? { wouldConflict } : {}),
      queueAheadSelection: await hostedQueueAheadSelection(ctx, state, undefined, queue?.entriesAhead),
      pendingAttempt,
      events,
      nextVersion,
      isDone: nextVersion > state.version,
      resnapshot,
    });
  } catch (error) {
    // Error-only, constant-size context. Do not log source, row values, caller
    // strings or exception payloads. Platform failures before execution need
    // the platform request trace; this identifies failures inside this query.
    if (!(error instanceof ForgeError) && !(error instanceof ConvexError))
      console.error('FORGE_FINISH_OBSERVE_FAILED', {
        projectId: input.projectId,
        operationId: /^[a-f0-9-]{36}$/i.test(input.operationId) ? input.operationId : null,
        nextVersion: Number.isSafeInteger(input.nextVersion) ? input.nextVersion : null,
        stage,
        phase,
        version,
        eventCount,
      });
    return report(error);
  }
}
