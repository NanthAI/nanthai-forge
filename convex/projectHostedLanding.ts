// SPDX-License-Identifier: Apache-2.0
import { memberWorkBudgetReply } from './abuseLimits';
import { checkCause, submittedCheckCause } from '../src/hosted-check';
import { withoutAuthorship, personStampValid } from '../src/work-actor-types';
import { sanitizeOutside } from '../src/run-evidence';
import { validateNotVerified } from '../src/agent-handoff-types';
import { bindLineSubmission } from './projectLiveLineSubmission';
import {
  capsuleHistoryContext,
  readCapsuleAttemptCursor,
  capsuleAttemptCursor,
  isCapsuleAttemptCursor,
} from './projectLandingCapsuleContext';
import { runProof } from './projectLandingProof';
import { held, heldPolicy, heldReview, noteHeldPolicy } from './projectHostedOwnerReview';
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
import {
  bindRunnerAccounting,
  bindSupersededCheck,
  type SupersededCheck,
} from './projectHostedLandingRunnerCosts';
import { startLandingAdmission } from './projectHostedLandingAdmission';
import { pipelineAdmission } from './projectHostedLandingAdmissionPipeline';
import {
  priorLandingForReservation,
  submissionReservation,
  landingReservationForReader,
} from './projectHostedLandingReservation';
import { preQueueCheck } from '../src/hosted-landing-admission';
import { landGateGuardEvidence, landGateTiming } from '../src/hosted-land-gates';
import { v } from 'convex/values';
import { mutation, query, receiptMutation } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { landingAgentClient, landingAgentRun } from '../src/agent-slug';
import { activeProject, accessibleProject, authorizedReadProject } from './projectAuthority';
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
  landingAttemptRow,
} from './projectHostedLandingStore';
import { wakeLandingQueue, notifyLandingCheck } from './projectHostedLandingWake';
import { initializeFinish } from './projectHostedFinishStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import {
  hostedLandingRequestSchema,
  hostedLandingCancelSchema,
  storedLandingStateSchema,
  landingObservation,
  landingHoldMs,
  landingTokensColumn,
} from '../src/hosted-landing';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { loadHostedCheck } from './projectHostedCheckStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { receiptMessageForReader } from './projectHostedAcceptanceMessage';
import { landingMessageForReader, landingWithoutClientHold } from './projectHostedLandingMessageBody';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { enforceLandGates } from './projectHostedLandGates';
import { requireQueueRoom } from './projectHostedQueueRoom';

/** Cancel a submission without changing Lane lifecycle; release its unneeded check. */
export const cancel = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx, true);
      const result = await cancelHostedLanding(ctx, {
        projectId: input.projectId,
        actor: actor.id,
        request: hostedLandingCancelSchema.parse(JSON.parse(input.request)),
      });
      return canonicalPayload(
        await landingMessageForReader(ctx, input.projectId, landingWithoutClientHold(result)),
      );
    } catch (error) {
      return report(error);
    }
  },
});

export const enqueue = receiptMutation({
  args: {
    memberBudget: v.optional(v.boolean()),
    projectId: v.id('hostedProjects'),
    request: v.string(),
    /** The calling agent run's slug (feature landing-agent-run, d730121f); not part of the request. */
    agent: v.optional(v.string()),
    /** The agent client: harness and declared model (feature landing-agent-client, 81d12a32). */
    agentClient: v.optional(v.string()),
    /** The CLI's land gate result (feature land-gates, Issue 029138ef); not part of the request. */
    gates: v.optional(v.string()),
    /** The agent's own reported tokens (feature landing-tokens, Item a61d3c91); not part of the request. */
    tokens: v.optional(v.number()),
    heldMs: v.optional(v.number()),
    /** Land only while the queue holds fewer checks (feature land-when-room, ad80e037); judged here,
     * for a new operation only, and not part of the request. */
    maxChecks: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const tokens = landingTokensColumn(input.tokens);
      const heldMs = landingHoldMs(input.heldMs);
      const request = hostedLandingRequestSchema.parse(JSON.parse(input.request));
      validateNotVerified(request.notVerified);
      const actor = await acceptanceActor(ctx, request.agent);
      const reply = memberWorkBudgetReply(
        ctx,
        { projectId: input.projectId, actor: actor.id },
        'landing',
        input.memberBudget,
      );
      const state = await enqueueHostedLanding(
        ctx,
        {
          projectId: input.projectId,
          ...landingAgentRun(input.agent),
          ...landingAgentClient(input.agentClient),
          ...tokens,
          heldMs,
          gates: { value: input.gates },
          ...(input.maxChecks === undefined ? {} : { maxChecks: input.maxChecks }),
        },
        request,
        actor,
      );
      const review = await heldReview(ctx, authorizedReadProject(ctx, input.projectId), state);
      const visible = heldMs === undefined ? landingWithoutClientHold(state) : state;
      const selected = await landingMessageForReader(ctx, input.projectId, visible);
      return reply(canonicalPayload(review ? { ...selected, ...review } : selected));
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
    capsuleProtocol: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await reader(ctx, input.projectId);
      const { row, state } = await loadLanding(ctx, input);
      if (state.acceptance?.proofRunId) {
        const proofRun = await loadHostedCheck(ctx, {
          projectId: input.projectId,
          runId: state.acceptance.proofRunId,
        });
        const proof = runProof(proofRun.row, proofRun.run);
        if (proof) state.acceptance = { ...state.acceptance, proof };
      }
      const wouldConflict = state.phase === 'queued' ? readWouldConflict(row) : undefined;
      const stallAlert = await latestStallAlert(ctx, input, state);
      const attemptKey = { projectId: input.projectId, attemptId: state.attemptId };
      const liveAttempt = await landingAttemptRow(ctx, attemptKey);
      const archived = !!row.capsule && !liveAttempt;
      const attempt = archived ? null : await loadLandingAttempt(ctx, attemptKey, liveAttempt);
      // A held landing says which policy it is pinned to and when it re-reads it: no extra read.
      const pin = held(state) && attempt ? heldPolicy(project, attempt) : null;
      const queue = await readQueueStatus(ctx, state);
      const orderWait = landingOrderWaitForReader(row, state);
      const reservation = landingReservationForReader(row);
      const review = await heldReview(ctx, project, state);
      const payload = {
        ...review,
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
      };
      return archived
        ? capsuleHistoryContext(ctx, project, row.capsule!, input.capsuleProtocol, state.id, payload)
        : canonicalPayload(payload);
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
        page: await Promise.all(
          page.page.map(row =>
            landingMessageForReader(
              ctx,
              input.projectId,
              landingPriorityState(row, storedLandingStateSchema.parse(JSON.parse(row.value))),
            ),
          ),
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
    capsuleProtocol: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await reader(ctx, input.projectId);
      const { row, state } = await loadLanding(ctx, input);
      if (row.capsule && !input.capsuleProtocol)
        return capsuleHistoryContext(ctx, project, row.capsule, input.capsuleProtocol, state.id, {});
      const after =
        input.capsuleProtocol && (row.capsule || isCapsuleAttemptCursor(input.cursor))
          ? readCapsuleAttemptCursor(input.cursor, input.submissionId)
          : null;
      const page = await ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project_and_submission_and_number', q => {
          const selected = q.eq('projectId', input.projectId).eq('submissionId', input.submissionId);
          return after === null ? selected : selected.gt('number', after);
        })
        .paginate({
          cursor: after === null ? input.cursor : null,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      const payload = {
        ...page,
        ...(input.capsuleProtocol
          ? {
              continueCursor: capsuleAttemptCursor(
                input.submissionId,
                page.page.at(-1)?.number ?? after ?? -1,
              ),
            }
          : {}),
        version: state.version,
        page: page.page.map(row => ({
          ...JSON.parse(row.value),
          progress: landingAttemptProgress(row, state),
          observation: landingAttemptProgress(row, state)?.observation ?? null,
          superseded: row.attemptId !== state.attemptId,
        })),
      };
      return row.capsule
        ? capsuleHistoryContext(ctx, project, row.capsule, input.capsuleProtocol, state.id, {
            ...payload,
            capsuleState: state,
            capsuleLiveBytes: page.page.map(row => [
              row.number,
              new TextEncoder().encode(canonicalPayload(row)).length,
            ]),
          })
        : canonicalPayload(payload);
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
    /** The agent's reported tokens (Item a61d3c91), range-checked by the public mutation. */
    agentTokens?: number | undefined;
    heldMs?: number | undefined;
    /** Guard-set evidence a desired landing kept from its gate (13ea93bf). */
    preflightRan?: string | undefined;
    preflightRuns?: number | undefined;
    /** Public entry point only: judge the project land gates (internal re-landings are not). */
    gates?: { value: string | undefined };
    /** Public entry point only: `land {maxChecks}` (convex/projectHostedQueueRoom.ts). */
    maxChecks?: number;
  },
  request: import('../src/hosted-landing').HostedLandingRequest,
  actor: import('../src/autonomy-policy').AcceptanceActor,
  reserved?: {
    submissionId: string;
    attemptId: string;
    at?: string;
    timing?: import('../src/hosted-landing').HostedLandingState['timing'];
    runnerAccounting?: import('./projectHostedLandingRunnerCosts').RunnerAccounting;
    supersedes?: string | undefined;
    retryReason?: import('../src/hosted-landing').HostedLandingState['retryReason'];
    counts?: import('../src/hosted-landing').HostedLandingState['counts'];
    supersededCheck?: SupersededCheck | undefined;
  },
) {
  invariant(
    personStampValid({ ...request, ...input }),
    'BAD_ARGUMENT',
    'A person stamp has no model or run.',
  );
  if (request.outside !== undefined) request = { ...request, outside: sanitizeOutside(request.outside) };
  const project = await activeProject(ctx, input.projectId, actor.id);
  const reused = await reuseHostedLanding(ctx, {
    projectId: input.projectId,
    actor: actor.id,
    request,
    project,
    workCharged: Boolean(reserved),
  });
  if (reused.state) return reused.state;
  const expected = {
    authorityEpoch: request.authorityEpoch,
    ...request.expectedMain,
    resourceId: request.candidateId,
  };
  const payload = { kind: 'hosted-landing', request: withoutAuthorship(request), actorKind: actor.kind };
  const prepared = await beginHostedOperation(ctx, {
    ...(reserved ? {} : { workKind: 'submissions' as const }),
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
  await requireQueueRoom(ctx, input.projectId, input.maxChecks);
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
  let prior: Awaited<ReturnType<typeof priorLandingForReservation>> = null;
  let paths: string[] | null = null;
  let mainMoved = false;
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
    intent: async id => {
      intentId = id;
      prior = await priorLandingForReservation(ctx, { projectId: input.projectId, intentId: id });
      const reason = request.retryReason ?? reserved?.retryReason ?? reused.retryReason;
      if (reason && reason !== 'other') return submittedCheckCause(reason);
      if (prior?.phase === 'terminal-failed' && prior.errorCode === 'CHECK_FAILED')
        return checkCause.needsFix;
      return submittedCheckCause(reason);
    },
    paths: value => (paths = value),
    mainMoved: value => (mainMoved = value),
  });
  const queue = await ensureLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
  const staleAdmission = mainMoved && attempt.deferredCheck;
  const stacked = staleAdmission
    ? null
    : await pipelineAdmission(ctx, { project, attempt, request, paths, queue });
  const admission =
    stacked || staleAdmission
      ? null
      : await startLandingAdmission(ctx, { projectId: input.projectId, attempt, request });
  // Issue 10d253c6: the same work superseded after a passed check reserves its files now.
  const reservation = intentId
    ? submissionReservation(prior, intentId, Boolean(request.finish), Date.now())
    : {};
  const sequence = queue.sequence + 1;
  const inherited = reserved?.counts ? reserved : reused;
  const carried = bindSupersededCheck(
    inherited.counts,
    inherited.supersededCheck,
    attempt.check?.runId ?? admission,
  );
  const state = storedLandingStateSchema.parse({
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
    ...(carried.counts ? { counts: carried.counts } : {}),
    ...((reserved?.supersedes ?? reused.supersedes)
      ? {
          supersedes: reserved?.supersedes ?? reused.supersedes,
          retryReason: reserved?.retryReason ?? reused.retryReason,
        }
      : {}),
    timing: {
      submittedAt: first.at,
      ...reserved?.timing,
      ...(input.heldMs === undefined ? {} : { heldMs: input.heldMs }),
      ...landGateTiming(input.gates?.value),
      composedAt: new Date().toISOString(),
    },
    observation: landingObservation(admission ? 'checking' : 'queued'),
    error: null,
  });
  await insertLandingAttempt(ctx, attempt);
  // Freeze the message before serializing the existing request row, while
  // preserving the original queue/finish wake order and transaction IO count.
  const finish = await initializeFinish(ctx, state, true);
  await ctx.db.insert('projectHostedLandingRequests', {
    runnerAccounting: bindRunnerAccounting(
      reserved?.runnerAccounting ?? reused.runnerAccounting ?? { root: submissionId, pending: 0 },
      attempt.check?.runId ?? admission,
    ),
    ...(carried.supersededCheck ? { supersededCheck: carried.supersededCheck } : {}),
    projectId: input.projectId,
    channel: request.channel,
    submissionId,
    operationId: request.operationId,
    candidateId: request.candidateId,
    ...(input.agentRun ? { agentRun: input.agentRun } : {}),
    ...(input.agentClient ? { agentClient: input.agentClient } : {}),
    ...(input.agentTokens === undefined ? {} : { agentTokens: input.agentTokens }),
    ...(input.gates
      ? landGateGuardEvidence(input.gates.value)
      : {
          ...(input.preflightRan === undefined ? {} : { preflightRan: input.preflightRan }),
          ...(input.preflightRuns === undefined ? {} : { preflightRuns: input.preflightRuns }),
        }),
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
    // The check's kind, stamped with its start as writeLanding does for later checks (ecd6e610,
    // fa2c1383). A scoped admission (own affected set) is neither kind and stays unstamped.
    ...(attempt.check || (admission && preQueueCheck(attempt.policy))
      ? { checkKind: attempt.recheck ? ('scoped' as const) : ('full' as const) }
      : {}),
    attemptId: attempt.id,
    value: canonicalPayload(state),
  });
  const lineCompose = request.finish?.composeOperationId
    ? { actor: state.actor, operationId: request.finish.composeOperationId }
    : request.finish
      ? await ctx.db
          .query('projectHostedComposes')
          .withIndex('by_project_and_candidate', q =>
            q.eq('projectId', input.projectId).eq('candidateId', request.candidateId),
          )
          .unique()
      : null;
  if (lineCompose && request.finish) await bindLineSubmission(ctx, state, lineCompose);
  await ctx.db.patch(queue._id, {
    sequence,
    ...(stacked && !queue.train?.length ? { train: [stacked] } : {}),
  });
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
  if (finish) await scheduleFinish(ctx, finish);
  await retainLandingProgress(ctx, state);
  await recordLandingObservation(ctx, state);
  await scheduleLandingAlarm(ctx, state);
  return state;
}

/** One Candidate subscription, no project queue scan or observer-driven work. */
export const candidate = query({
  args: {
    projectId: v.id('hostedProjects'),
    candidateId: v.string(),
    capsuleProtocol: v.optional(v.literal(1)),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    try {
      const project = await reader(ctx, input.projectId);
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
      const { state, row: selectedRow } = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: row.submissionId,
      });
      const attemptKey = { projectId: input.projectId, attemptId: state.attemptId };
      const liveAttempt = await landingAttemptRow(ctx, attemptKey);
      const archived = !!selectedRow.capsule && !liveAttempt;
      const attempt = archived ? null : await loadLandingAttempt(ctx, attemptKey, liveAttempt);
      const run = attempt?.check
        ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: attempt.check.runId })).run
        : null;
      if (state.acceptance?.proofRunId) {
        const proofRun = await loadHostedCheck(ctx, {
          projectId: input.projectId,
          runId: state.acceptance.proofRunId,
        });
        const proof = runProof(proofRun.row, proofRun.run);
        if (proof) state.acceptance = { ...state.acceptance, proof };
      }
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
      const readable = await landingMessageForReader(ctx, input.projectId, state);
      const payload = {
        request:
          state.observation.state === 'pending' && run?.status === 'unknown'
            ? { ...readable, observation: { ...readable.observation, pendingReason: 'pending-infra' } }
            : readable,
        attempt,
        run,
        reverseCandidateId: reverse?.candidateId ?? null,
        message: finish ? JSON.parse(finish.value).source.message : null,
        pendingAttempt: finish ? finishPendingForReader(JSON.parse(finish.value).pending) : null,
        receipt: receipt
          ? await receiptMessageForReader(ctx, input.projectId, JSON.parse(receipt.value), receipt.sequence)
          : null,
        ahead:
          ahead && !['landed', 'terminal-failed'].includes(ahead.phase)
            ? JSON.parse(ahead.value).request.candidateId
            : null,
      };
      return archived
        ? capsuleHistoryContext(ctx, project, selectedRow.capsule!, input.capsuleProtocol, state.id, payload)
        : canonicalPayload(payload);
    } catch (error) {
      return report(error);
    }
  },
});
