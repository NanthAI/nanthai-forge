// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { activeProject, accessibleProject } from './projectAuthority';
import { beginHostedOperation } from './projectHostedOperations';
import {
  ensureLandingQueue,
  landingRow,
  loadLanding,
  loadLandingAttempt,
  insertLandingAttempt,
} from './projectHostedLandingStore';
import { wakeLandingQueue, notifyLandingCheck } from './projectHostedLandingWake';
import { initializeFinish } from './projectHostedFinishStore';
import { pinLandingAttempt } from './projectHostedLandingPins';
import {
  hostedLandingRequestSchema,
  hostedLandingStateSchema,
  landingObservation,
} from '../src/hosted-landing';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const enqueue = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = hostedLandingRequestSchema.parse(JSON.parse(input.request));
      const actor = await acceptanceActor(ctx, request.agent);
      await activeProject(ctx, input.projectId, actor.id);
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
          id: crypto.randomUUID(),
          parentAttemptId: null,
          at: new Date().toISOString(),
          expected,
          ids: { submission: crypto.randomUUID(), check: crypto.randomUUID(), accept: crypto.randomUUID() },
        },
      });
      const first = prepared.operation.firstAttempt;
      if (prepared.replayed) {
        const { row, state } = await loadLanding(ctx, {
          projectId: input.projectId,
          submissionId: first.ids.submission!,
        });
        // Retrying a lost wake repairs scheduling, never replaces immutable pins.
        if (row.runnable)
          await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
        else if (state.phase === 'checking' && row.runId)
          await notifyLandingCheck(ctx, { projectId: input.projectId, runId: row.runId });
        await initializeFinish(ctx, state);
        return canonicalPayload(state);
      }
      const submissionId = first.ids.submission!;
      const attempt = await pinLandingAttempt(ctx, {
        projectId: input.projectId,
        actor,
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
        version: 0,
        firstAttemptId: attempt.id,
        attemptId: attempt.id,
        phase: 'queued',
        observation: landingObservation('queued'),
        error: null,
      });
      await insertLandingAttempt(ctx, attempt);
      await ctx.db.insert('projectHostedLandingRequests', {
        projectId: input.projectId,
        channel: request.channel,
        submissionId,
        operationId: request.operationId,
        actor: actor.id,
        sequence,
        runnable: true,
        phase: state.phase,
        runId: attempt.check?.runId ?? null,
        attemptId: attempt.id,
        value: canonicalPayload(state),
      });
      await ctx.db.patch(queue._id, { sequence });
      await wakeLandingQueue(ctx, { projectId: input.projectId, channel: request.channel });
      await initializeFinish(ctx, state);
      return canonicalPayload(state);
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
  args: { projectId: v.id('hostedProjects'), submissionId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      const { state } = await loadLanding(ctx, input);
      const attempt = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      return canonicalPayload({ request: state, attempt });
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
      return canonicalPayload({ ...page, page: page.page.map(row => JSON.parse(row.value)) });
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
          observation:
            row.attemptId === state.attemptId
              ? state.observation
              : { state: 'superseded', pendingReason: null, cause: null },
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
