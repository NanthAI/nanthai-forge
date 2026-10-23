// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { activeProject, accessibleProject } from './projectAuthority';
import { loadFinish } from './projectHostedFinishStore';
import { acceptancePage, acceptancePlan } from './projectHostedAcceptanceStore';
import { loadLandingAttempt, landingAttemptRow, landingAttemptProgress } from './projectHostedLandingStore';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { sourceSubmission } from '../src/landing-submission-state';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { loadLanding } from './projectHostedLandingStore';
import { scheduleFinish } from './projectHostedFinishWake';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
/** Event/startup repair of this one pending request. It allocates no new attempt
 * and never polls a project, repeats a check or changes the original selection. */
export const resume = mutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const { state } = await loadLanding(ctx, input);
      const actor = await acceptanceActor(ctx, state.request.agent);
      invariant(actor.id === state.actor, 'PROJECT_UNAVAILABLE', 'Resume the original finish actor.');
      const pending = state.phase !== 'landed' && state.phase !== 'terminal-failed';
      // Identity is not a retained contributor grant. Check current access before
      // even repairing a scheduler receipt; history needs access but no old epoch.
      if (pending) await hostedWriteProject(ctx, input.projectId, actor.id, state.request.authorityEpoch);
      else await activeProject(ctx, input.projectId, actor.id);
      const { row } = await loadFinish(ctx, input);
      if (pending) await scheduleFinish(ctx, row);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** S05-style cursor: observers subscribe/reconnect to one request version. They
 * cause no wake or compute. A named pending source phase is visible immediately. */
export const status = query({
  args: { ...identity, version: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted finish progress.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const { state } = await loadLanding(ctx, input),
        { value } = await loadFinish(ctx, input);
      return canonicalPayload({
        version: state.version,
        unchanged: input.version === state.version,
        submission: state,
        pendingAttempt: value.pending,
        selection: { inputs: value.source.inputs, dependencies: value.source.dependencies },
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Explicit immutable input-page read, with current Lane-relative S01 states.
 * Regular status stays constant-size even for a many-Lane finish. */
export const inputs = query({
  args: { ...identity, attemptId: v.string(), index: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted finish inputs.');
      await accessibleProject(ctx, input.projectId, user.subject);
      invariant(
        Number.isSafeInteger(input.index) && input.index >= 0,
        'BAD_ARGUMENT',
        'Select an input page index.',
      );
      const { state } = await loadLanding(ctx, input),
        attempt = await loadLandingAttempt(ctx, input);
      invariant(attempt.submissionId === state.id, 'NOT_FOUND', 'Attempt belongs to a different submission.');
      const identity = { projectId: input.projectId, receiptId: attempt.operations.accept };
      const plan = await acceptancePlan(ctx, identity);
      const page = await acceptancePage(ctx, { ...identity, kind: 'inputs', index: input.index });
      const attemptRow = (await landingAttemptRow(ctx, input))!;
      const progress = landingAttemptProgress(attemptRow, state);
      const entries = [];
      for (const item of page ? validateComposePage(JSON.parse(page.value)).entries : []) {
        const pin = composeLaneSchema.parse(item);
        const row = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: user.subject,
          kind: 'lane',
          key: pin.laneId,
        });
        invariant(row, 'SOURCE_UNAVAILABLE', 'Included Lane is unavailable.');
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        const observation = progress?.observation;
        invariant(observation, 'SOURCE_UNAVAILABLE', 'Historical attempt evidence is unavailable.');
        invariant(
          observation.state !== 'superseded',
          'SOURCE_UNAVAILABLE',
          'A stored outcome cannot erase the actual submission result.',
        );
        entries.push({
          submissionId: state.id,
          operationId: state.operationId,
          laneId: lane.id,
          intentId: lane.intentId,
          head: pin.head,
          attemptHead: pin.head,
          attemptId: attempt.id,
          error: progress?.error ?? null,
          acceptance: progress?.acceptance ?? null,
          ...sourceSubmission({ ...observation, state: observation.state }, lane.head, pin.head),
        });
      }
      return canonicalPayload({
        entries,
        version: state.version,
        staged: page !== null,
        nextIndex: page ? (JSON.parse(page.value).next ? input.index + 1 : null) : input.index,
        preparedPages: plan?.inputPages ?? 0,
      });
    } catch (error) {
      return report(error);
    }
  },
});
