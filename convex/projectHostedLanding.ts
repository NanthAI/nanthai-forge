// SPDX-License-Identifier: Apache-2.0
import { held, heldPolicy, noteHeldPolicy } from './projectHostedOwnerReview';
import { readQueueStatus, queueAwareLandingState } from './projectHostedQueueStatus';
import { finishPendingForReader } from '../src/hosted-finish';
import {
  landingPriority,
  nextLandingRow,
  landingPriorityState,
  landingStateForReader,
  landingOrderWaitForReader,
} from './projectHostedLandingOrder';
import { hostedQueueAheadSelection } from './projectHostedQueueAhead';
import { scheduleLandingAlarm } from './projectHostedLandingStallWake';
import { readWouldConflict, syncRequiredQueue } from './projectHostedLandingWouldConflict';
import { latestStallAlert } from './projectHostedLandingStallAlert';
import { reuseHostedLanding } from './projectHostedLandingIdentity';
import { startLandingAdmission } from './projectHostedLandingAdmission';
import { submissionReservation, landingReservationForReader } from './projectHostedLandingReservation';
import { preQueueCheck } from '../src/hosted-landing-admission';
import { v } from 'convex/values';
import { mutation, query, receiptMutation } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { landingAgentClient, landingAgentRun } from '../src/agent-slug';
import { activeProject, accessibleProject } from './projectAuthority';
import { beginHostedOperation } from './projectHostedOperations';
import {
  ensureLandingQueue,
  landingRow,
  landingQueue,
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
  recordLandingObservation,
  retainLandingProgress,
  landingAttemptProgress,
} from './projectHostedLandingStore';
import { wakeLandingQueue, notifyLandingCheck } from './projectHostedLandingWake';
import { initializeFinish } from './projectHostedFinishStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import {
  hostedLandingRequestSchema,
  hostedLandingCancelSchema,
  hostedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { loadHostedCheck } from './projectHostedCheckStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { enforceLandGates } from './projectHostedLandGates';

/** Cancel a submission without changing Lane lifecycle; release its unneeded check. */
export const cancel = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx, true);
      return canonicalPayload(
        await cancelHostedLanding(ctx, {
          projectId: input.projectId,
          actor: actor.id,
          request: hostedLandingCancelSchema.parse(JSON.parse(input.request)),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});

export const enqueue = receiptMutation({
  args: {
    projectId: v.id('hostedProjects'),
    request: v.string(),
    /** The calling agent run's slug (feature landing-agent-run, d730121f); not part of the request. */
    agent: v.optional(v.string()),
    /** The agent client: harness and declared model (feature landing-agent-client, 81d12a32). */
    agentClient: v.optional(v.string()),
    /** The CLI's land gate result (feature land-gates, Issue 029138ef); not part of the request. */
    gates: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = hostedLandingRequestSchema.parse(JSON.parse(input.request));
      const actor = await acceptanceActor(ctx, request.agent);
      return canonicalPayload(
        await enqueueHostedLanding(
          ctx,
          {
            projectId: input.projectId,
            ...landingAgentRun(input.agent),
            ...landingAgentClient(input.agentClient),
            gates: { value: input.gates },
          },
          request,
          actor,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});
async function reader(
  ctx: Parameters<typeof accessibleProject>[0],
  projectId: Parameters<typeof accessibleProject>[1],
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted landing requests.');
  return accessibleProject(ctx, projectId, user.subject);
}
export const status = query({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    priorityInfo: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await reader(ctx, input.projectId);
      const { row, state } = await loadLanding(ctx, input);
      const wouldConflict = state.phase === 'queued' ? readWouldConflict(row) : undefined;
      const stallAlert = await latestStallAlert(ctx, input, state);
      const attempt = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      // A held landing says which policy it is pinned to and when it re-reads it: no extra read.
      const pin = held(state) ? heldPolicy(project, attempt) : null;
      const queue = await readQueueStatus(ctx, state);
      const orderWait = landingOrderWaitForReader(row, state);
      const reservation = landingReservationForReader(row);
      return canonicalPayload({
        request: noteHeldPolicy(
          landingStateForReader(queueAwareLandingState(state, queue), input.priorityInfo),
          pin,
        ),
        queuePosition: queue?.position ?? null,
        queue: syncRequiredQueue(queue, wouldConflict),
        ...(orderWait ? { orderWait } : {}),
        attempt,
        queueAheadSelection: await hostedQueueAheadSelection(ctx, state, undefined, queue?.entriesAhead),
        ...(wouldConflict ? { wouldConflict } : {}),
        ...(stallAlert ? { stallAlert } : {}),
        ...(reservation ? { reservation } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    phase: v.optional(
      v.union(
        v.literal('queued'),
        v.literal('checking'),
        v.literal('ready'),
        v.literal('terminal-failed'),
        v.literal('landed'),
      ),
    ),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      const rows =
        input.phase === undefined
          ? ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_channel_and_sequence', q =>
                q.eq('projectId', input.projectId).eq('channel', input.channel),
              )
          : ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
                q.eq('projectId', input.projectId).eq('channel', input.channel).eq('phase', input.phase!),
              );
      const page = await rows.paginate({
        cursor: input.cursor,
        numItems: 100,
        maximumRowsRead: 100,
        maximumBytesRead: 128 * 1024,
      });
      return canonicalPayload({
        ...page,
        page: page.page.map(row =>
          landingPriorityState(row, hostedLandingStateSchema.parse(JSON.parse(row.value))),
        ),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const attempts = query({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      invariant(await landingRow(ctx, input), 'NOT_FOUND', 'Hosted landing request not found.');
      const page = await ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project_and_submission_and_number', q =>
          q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
        )
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      const { state } = await loadLanding(ctx, input);
      return canonicalPayload({
        ...page,
        version: state.version,
        page: page.page.map(row => ({
          ...JSON.parse(row.value),
          progress: landingAttemptProgress(row, state),
          observation: landingAttemptProgress(row, state)?.observation ?? null,
          superseded: row.attemptId !== state.attemptId,
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

export async function enqueueHostedLanding(
  ctx: import('./_generated/server').MutationCtx,
  input: {
    projectId: import('./_generated/dataModel').Id<'hostedProjects'>;
    agentRun?: string | undefined;
    agentClient?: string | undefined;
    /** Public entry point only: judge the project land gates (internal re-landings are not). */
    gates?: { value: string | undefined };
  },
  request: import('../src/hosted-landing').HostedLandingRequest,
  actor: import('../src/autonomy-policy').AcceptanceActor,
  reserved?: {
    submissionId: string;
    attemptId: string;
    at?: string;
    timing?: import('../src/hosted-landing').HostedLandingState['timing'];
    supersedes?: string | undefined;
    retryReason?: import('../src/hosted-landing').HostedLandingState['retryReason'];
  },
) {
  const project = await activeProject(ctx, input.projectId, actor.id);
  const reused = await reuseHostedLanding(ctx, { projectId: input.projectId, actor: actor.id, request });
  if (reused.state) return reused.state;
  const expected = {
    authorityEpoch: request.authorityEpoch,
    ...request.expectedMain,
    resourceId: request.candidateId,
  };
  const payload = { kind: 'hosted-landing', request, actorKind: actor.kind };
  const prepared = await beginHostedOperation(ctx, {
    projectId: input.projectId,
    actor: actor.id,
    payload,
    request: {
      schema: 1,
      projectId: input.projectId,
      actor: actor.id,
      operationId: request.operationId,
      expected,
      payloadHash: hostedPayloadHash(payload, expected),
    },
    firstAttempt: {
      projectId: input.projectId,
      operationId: request.operationId,
      id: reserved?.attemptId ?? crypto.randomUUID(),
      parentAttemptId: null,
      at: reserved?.at ?? new Date().toISOString(),
      expected,
      ids: {
        submission: reserved?.submissionId ?? crypto.randomUUID(),
        check: crypto.randomUUID(),
        accept: crypto.randomUUID(),
      },
    },
  });
  const first = prepared.operation.firstAttempt;
  if (prepared.replayed) {
    const { row, state } = await loadLanding(ctx, {
      projectId: input.projectId,
      submissionId: first.ids.submission!,
    });
    // Retrying a lost wake repairs scheduling, never replaces immutable pins.
    if (row.runnable) await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
    else if (state.phase === 'checking' && row.runId)
      await notifyLandingCheck(ctx, { projectId: input.projectId, runId: row.runId });
    await initializeFinish(ctx, state);
    return state;
  }
  // A new operation only: a replay above returns its retained landing unjudged.
  if (input.gates)
    await enforceLandGates(ctx, {
      projectId: input.projectId,
      project,
      actor,
      composeOperationId: request.finish?.composeOperationId,
      gates: input.gates.value,
    });
  const submissionId = first.ids.submission!;
  let intentId: string | undefined;
  const attempt = await pinLandingAttempt(ctx, {
    projectId: input.projectId,
    actor,
    allowStaleMain: reserved !== undefined,
    request,
    submissionId,
    attemptId: first.id,
    parentAttemptId: null,
    number: 0,
    at: first.at,
    operations: { check: first.ids.check!, accept: first.ids.accept! },
    intent: id => (intentId = id),
  });
  const admission = await startLandingAdmission(ctx, { projectId: input.projectId, attempt, request });
  // Issue 10d253c6: the same work superseded after a passed check reserves its files now.
  const reservation = await submissionReservation(ctx, { projectId: input.projectId, intentId }, Date.now());
  const queue = await ensureLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
  const sequence = queue.sequence + 1;
  const state = hostedLandingStateSchema.parse({
    schema: 1,
    projectId: input.projectId,
    id: submissionId,
    operationId: request.operationId,
    actor: actor.id,
    at: first.at,
    request,
    sequence,
    ...landingPriority(project, actor, request.priority),
    priorityVersion: 0,
    version: reserved ? 1 : 0,
    firstAttemptId: attempt.id,
    attemptId: attempt.id,
    phase: admission ? 'checking' : 'queued',
    ...((reserved?.supersedes ?? reused.supersedes)
      ? {
          supersedes: reserved?.supersedes ?? reused.supersedes,
          retryReason: reserved?.retryReason ?? reused.retryReason,
        }
      : {}),
    timing: { submittedAt: first.at, ...reserved?.timing, composedAt: new Date().toISOString() },
    observation: landingObservation(admission ? 'checking' : 'queued'),
    error: null,
  });
  await insertLandingAttempt(ctx, attempt);
  // Freeze the message before serializing the existing request row, while
  // preserving the original queue/finish wake order and transaction IO count.
  const finish = await initializeFinish(ctx, state, true);
  await ctx.db.insert('projectHostedLandingRequests', {
    projectId: input.projectId,
    channel: request.channel,
    submissionId,
    operationId: request.operationId,
    candidateId: request.candidateId,
    ...(input.agentRun ? { agentRun: input.agentRun } : {}),
    ...(input.agentClient ? { agentClient: input.agentClient } : {}),
    ...(attempt.deferredCheck ? { batchSelection: canonicalPayload(attempt), batchable: !admission } : {}),
    ...(admission
      ? {
          admission: {
            runId: admission,
            status: 'checking' as const,
            ...(preQueueCheck(attempt.policy) ? { full: true as const } : {}),
          },
          admitting: true as const,
        }
      : {}),
    ...(request.revertOf ? { revertOf: request.revertOf } : {}),
    ...reservation,
    actor: actor.id,
    ...landingPriority(project, actor, request.priority),
    priorityVersion: 0,
    sequence,
    ...(reused.selectionKey ? { selectionKey: reused.selectionKey } : {}),
    runnable: !admission,
    // An admission run is pre-queue: no queue order until it settles.
    ...(admission ? {} : { orderLive: true as const }),
    phase: state.phase as import('./projectHostedLandingStore').LandingRow['phase'],
    runId: attempt.check?.runId ?? admission,
    attemptId: attempt.id,
    value: canonicalPayload(state),
  });
  await ctx.db.patch(queue._id, { sequence });
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
  if (finish) await scheduleFinish(ctx, finish);
  await retainLandingProgress(ctx, state);
  await recordLandingObservation(ctx, state);
  await scheduleLandingAlarm(ctx, state);
  return state;
}

/** One Candidate subscription, no project queue scan or observer-driven work. */
export const candidate = query({
  args: { projectId: v.id('hostedProjects'), candidateId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      const [row] = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_candidate_and_sequence', q =>
          q.eq('projectId', input.projectId).eq('candidateId', input.candidateId),
        )
        .order('desc')
        .take(1);
      if (!row) {
        const [check] = await ctx.db
          .query('projectHostedCheckRuns')
          .withIndex('by_project_and_candidate', q =>
            q.eq('projectId', input.projectId).eq('candidateId', input.candidateId),
          )
          .order('desc')
          .take(1);
        return canonicalPayload({
          request: null,
          run: check
            ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: check.runId })).run
            : null,
        });
      }
      const { state } = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: row.submissionId,
      });
      const attempt = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      const run = attempt.check
        ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: attempt.check.runId })).run
        : null;
      const finish = await finishRow(ctx, { projectId: input.projectId, submissionId: state.id });
      const receipt = state.acceptance
        ? await acceptanceRow(ctx, { projectId: input.projectId, receiptId: state.acceptance.receiptId })
        : null;
      const queue =
        state.phase === 'queued'
          ? await landingQueue(ctx, { projectId: input.projectId, channel: 'main' })
          : null;
      const runnable =
        state.phase === 'queued'
          ? await nextLandingRow(ctx, { projectId: input.projectId, channel: 'main' })
          : null;
      const ahead =
        queue?.lease && queue.lease.submissionId !== state.id
          ? await landingRow(ctx, { projectId: input.projectId, submissionId: queue.lease.submissionId })
          : runnable && runnable.submissionId !== row.submissionId
            ? runnable
            : null;
      const [reverse] = state.acceptance
        ? await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_revert_and_sequence', q =>
              q.eq('projectId', input.projectId).eq('revertOf', state.acceptance!.receiptId),
            )
            .order('desc')
            .take(1)
        : [];
      return canonicalPayload({
        request:
          state.observation.state === 'pending' && run?.status === 'unknown'
            ? { ...state, observation: { ...state.observation, pendingReason: 'pending-infra' } }
            : state,
        attempt,
        run,
        reverseCandidateId: reverse?.candidateId ?? null,
        message: finish ? JSON.parse(finish.value).source.message : null,
        pendingAttempt: finish ? finishPendingForReader(JSON.parse(finish.value).pending) : null,
        receipt: receipt ? JSON.parse(receipt.value) : null,
        ahead:
          ahead && !['landed', 'terminal-failed'].includes(ahead.phase)
            ? JSON.parse(ahead.value).request.candidateId
            : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
