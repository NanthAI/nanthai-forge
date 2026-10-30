import {
  landingPriority,
  landingQueuePosition,
  nextLandingRow,
  activeLandingOrder,
  landingPriorityState,
  landingStateForReader,
} from './projectHostedLandingOrder';
import { hostedQueueAheadSelection } from './projectHostedQueueAhead';
import { scheduleLandingAlarm } from './projectHostedLandingStallWake';
import { reuseHostedLanding } from './projectHostedLandingIdentity';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
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
import { finishRow } from './projectHostedFinishWake';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';

/** Cancel a submission, independently of Lane lifecycle or check execution. */
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

export const enqueue = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = hostedLandingRequestSchema.parse(JSON.parse(input.request));
      const actor = await acceptanceActor(ctx, request.agent);
      return canonicalPayload(await enqueueHostedLanding(ctx, input, request, actor));
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
  await accessibleProject(ctx, projectId, user.subject);
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
      await reader(ctx, input.projectId);
      const { state } = await loadLanding(ctx, input);
      const attempt = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      const order =
        state.phase === 'queued'
          ? await activeLandingOrder(ctx, { projectId: input.projectId, channel: 'main' })
          : undefined;
      return canonicalPayload({
        request: landingStateForReader(state, input.priorityInfo),
        queuePosition: await landingQueuePosition(ctx, state, order),
        attempt,
        queueAheadSelection: await hostedQueueAheadSelection(ctx, state, order),
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
  input: { projectId: import('./_generated/dataModel').Id<'hostedProjects'> },
  request: import('../src/hosted-landing').HostedLandingRequest,
  actor: import('../src/autonomy-policy').AcceptanceActor,
  reserved?: {
    submissionId: string;
    attemptId: string;
    at?: string;
    timing?: import('../src/hosted-landing').HostedLandingState['timing'];
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
  const submissionId = first.ids.submission!;
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
  });
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
    ...landingPriority(project.owner, actor.id, request.priority),
    priorityVersion: 0,
    version: reserved ? 1 : 0,
    firstAttemptId: attempt.id,
    attemptId: attempt.id,
    phase: 'queued',
    timing: { submittedAt: first.at, ...reserved?.timing, composedAt: new Date().toISOString() },
    observation: landingObservation('queued'),
    error: null,
  });
  await insertLandingAttempt(ctx, attempt);
  await ctx.db.insert('projectHostedLandingRequests', {
    projectId: input.projectId,
    channel: request.channel,
    submissionId,
    operationId: request.operationId,
    candidateId: request.candidateId,
    ...(attempt.deferredCheck ? { batchSelection: canonicalPayload(attempt), batchable: true } : {}),
    ...(request.revertOf ? { revertOf: request.revertOf } : {}),
    actor: actor.id,
    ...landingPriority(project.owner, actor.id, request.priority),
    priorityVersion: 0,
    sequence,
    ...(reused.selectionKey ? { selectionKey: reused.selectionKey } : {}),
    runnable: true,
    phase: state.phase as import('./projectHostedLandingStore').LandingRow['phase'],
    runId: attempt.check?.runId ?? null,
    attemptId: attempt.id,
    value: canonicalPayload(state),
  });
  await ctx.db.patch(queue._id, { sequence });
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
  await initializeFinish(ctx, state);
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
        pendingAttempt: finish ? JSON.parse(finish.value).pending : null,
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
