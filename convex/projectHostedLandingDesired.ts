import { landingPriority } from './projectHostedLandingOrder';
import { scheduleLandingAlarm } from './projectHostedLandingStallWake';
import { desiredWatchdogMs } from '../src/hosted-landing-stall';
import { desiredLanding, scheduleDesired as schedule } from './projectHostedLandingDesiredWake';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { receiptMutation, internalMutation, internalAction } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { activeProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { loadCompose } from './projectHostedComposeStore';
import { enqueueHostedLanding } from './projectHostedLanding';
import { landingAlias } from './projectHostedLandingIdentity';
import { landingRow } from './projectHostedLandingStore';
import { hostedLandingDesiredSchema } from '../src/hosted-landing-desired';
import { hostedLandingStateSchema, landingObservation } from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';

const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
/** Register the goal while the first source job runs. The selected source pages
 * are already staged; no Mac, client journal or further client mutation is needed. */
export const submit = receiptMutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const command = hostedLandingDesiredSchema.parse(JSON.parse(input.request));
      const actor = await acceptanceActor(ctx, true);
      const project = await hostedWriteProject(ctx, input.projectId, actor.id, command.authorityEpoch);
      const request = canonicalPayload(command);
      const old = await ctx.db
        .query('projectHostedLandingDesired')
        .withIndex('by_project_and_actor_and_operation', q =>
          q.eq('projectId', input.projectId).eq('actor', actor.id).eq('operationId', command.operationId),
        )
        .unique();
      if (old) {
        invariant(old.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original desired landing.');
        const canonical = await landingRow(ctx, old);
        return canonical?.value ?? old.value;
      }
      const alias = await landingAlias(ctx, {
        projectId: input.projectId,
        actor: actor.id,
        operationId: command.operationId,
      });
      if (alias) {
        invariant(
          alias.requestHash === digest(request),
          'WORK_OPERATION_CHANGED',
          'Replay the original desired landing.',
        );
        const canonical = await landingRow(ctx, alias);
        const desired = canonical ? null : await desiredLanding(ctx, alias);
        invariant(canonical || desired, 'SOURCE_UNAVAILABLE', 'Original desired landing is unavailable.');
        return canonical?.value ?? desired!.value;
      }
      const source = await loadCompose(ctx, {
        projectId: input.projectId,
        actor: actor.id,
        operationId: command.composeOperationId,
      });
      invariant(
        ['submitted', 'completed', 'failed'].includes(source.state.status),
        'WORK_STALE',
        'Submit the staged source job first.',
      );
      invariant(
        source.state.request.authorityEpoch === command.authorityEpoch,
        'SOURCE_AUTHORITY_CHANGED',
        'Retain the original source authority.',
      );
      const selectionKey = digest(
        canonicalPayload({
          channel: 'main',
          ...(command.priority === 'urgent' ? { priority: 'urgent' } : {}),
          agent: true,
          check: command.check,
          inputs: source.state.request.inputs.root,
          dependencies: source.state.request.dependencies.root,
          after: command.after,
        }),
      );
      const [queued] = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_selection', q =>
          q.eq('projectId', input.projectId).eq('selectionKey', selectionKey),
        )
        .order('desc')
        .take(1);
      const queuedState = queued && hostedLandingStateSchema.parse(JSON.parse(queued.value));
      if (queued && queuedState?.observation.state !== 'terminal-failed') {
        await ctx.db.insert('projectHostedLandingAliases', {
          projectId: input.projectId,
          actor: actor.id,
          operationId: command.operationId,
          requestHash: digest(request),
          submissionId: queued.submissionId,
        });
        return queued.value;
      }
      const [existing] = await ctx.db
        .query('projectHostedLandingDesired')
        .withIndex('by_project_and_selection', q =>
          q.eq('projectId', input.projectId).eq('selectionKey', selectionKey),
        )
        .order('desc')
        .take(1);
      const existingCanonical = existing && (await landingRow(ctx, existing));
      const existingState =
        existing && hostedLandingStateSchema.parse(JSON.parse(existingCanonical?.value ?? existing.value));
      if (existing && existingState?.observation.state !== 'terminal-failed') {
        await ctx.db.insert('projectHostedLandingAliases', {
          projectId: input.projectId,
          actor: actor.id,
          operationId: command.operationId,
          requestHash: digest(request),
          submissionId: existing.submissionId,
        });
        return existingCanonical?.value ?? existing.value;
      }
      const previous = queuedState ?? existingState;
      const id = crypto.randomUUID(),
        attemptId = crypto.randomUUID(),
        at = new Date().toISOString();
      const state = hostedLandingStateSchema.parse({
        schema: 1,
        projectId: input.projectId,
        id,
        operationId: command.operationId,
        actor: actor.id,
        at,
        sequence: 0,
        ...landingPriority(project.owner, actor.id, command.priority),
        priorityVersion: 0,
        version: 0,
        firstAttemptId: attemptId,
        attemptId,
        phase: 'composing',
        preparing: true,
        ...(previous?.observation.state === 'terminal-failed'
          ? { supersedes: previous.id, retryReason: command.retryReason ?? 'other' }
          : {}),
        observation: landingObservation('queued'),
        error: null,
        timing: { submittedAt: at, composeStartedAt: source.operation.firstAttempt.at },
        request: {
          ...(command.governanceVersion ? { governanceVersion: command.governanceVersion } : {}),
          operationId: command.operationId,
          authorityEpoch: command.authorityEpoch,
          channel: 'main',
          expectedMain: source.state.request.expectedMain,
          candidateId: source.state.candidateId,
          expectedHead: null,
          agent: true,
          ...(command.priority ? { priority: command.priority } : {}),
          check: command.check,
          ...(command.retryReason ? { retryReason: command.retryReason } : {}),
          ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
          finish: { composeOperationId: command.composeOperationId, after: command.after },
        },
      });
      const key = await ctx.db.insert('projectHostedLandingDesired', {
        projectId: input.projectId,
        actor: actor.id,
        operationId: command.operationId,
        submissionId: id,
        composeOperationId: command.composeOperationId,
        selectionKey,
        request,
        value: canonicalPayload(state),
        wake: null,
      });
      await schedule(ctx, (await ctx.db.get(key))!, 0);
      await scheduleLandingAlarm(ctx, state);
      return canonicalPayload(state);
    } catch (error) {
      return report(error);
    }
  },
});
/** Claim and advance are separate transactions: a killed action leaves a fenced
 * watchdog. Only pending goals own a timer; source publication also wakes them. */
export const claim = internalMutation({
  args: { ...identity, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    if (state.observation.state !== 'pending') {
      await ctx.scheduler.cancel(row.wake.taskId);
      await ctx.db.patch(row._id, { wake: null });
      return null;
    }
    return schedule(ctx, row, desiredWatchdogMs(state));
  },
});
export const advance = internalMutation({
  args: { ...identity, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    try {
      await activeProject(ctx, row.projectId, row.actor);
      const source = await loadCompose(ctx, {
        projectId: row.projectId,
        actor: row.actor,
        operationId: row.composeOperationId,
      });
      const terminal = source.operation.terminal;
      if (!terminal) return null;
      if (terminal.outcome.status === 'failed')
        throw new ForgeError(terminal.outcome.error.code, terminal.outcome.error.message);
      const candidate = hostedRecordSchema.options[3].parse(terminal.outcome.result);
      const result = await enqueueHostedLanding(
        ctx,
        row,
        {
          ...state.request,
          expectedMain: candidate.base,
          candidateId: candidate.id,
          expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
        },
        { id: row.actor, kind: 'agent' },
        {
          submissionId: state.id,
          attemptId: state.attemptId,
          at: state.at,
          timing: state.timing,
          supersedes: state.supersedes,
          retryReason: state.retryReason,
        },
      );
      if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
      await ctx.db.patch(row._id, { value: canonicalPayload(result), wake: null });
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
/** Admission failures roll back their whole transaction before this independent
 * failure publication. A failed check reservation cannot leave a partial queue. */
export const fail = internalMutation({
  args: { ...identity, wakeId: v.string(), code: v.string(), message: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    const failed = {
      ...state,
      version: state.version + 1,
      phase: 'terminal-failed' as const,
      timing: { submittedAt: state.at, ...state.timing, settledAt: new Date().toISOString() },
      observation: landingObservation('failed', input.code),
      error: { code: input.code, message: input.message },
    };
    await ctx.scheduler.cancel(row.wake.taskId);
    await scheduleLandingAlarm(ctx, failed);
    await ctx.db.patch(row._id, { value: canonicalPayload(failed), wake: null });
    return canonicalPayload(failed);
  },
});
export const drive = internalAction({
  args: { ...identity, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input): Promise<string | null> => {
    const wakeId: string | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedLandingDesired:claim'),
      input,
    );
    if (!wakeId) return null;
    try {
      return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingDesired:advance'), {
        ...input,
        wakeId,
      });
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'data' in error
          ? hostedLandingStateSchema.shape.error.safeParse(error.data)
          : null;
      if (!detail?.success || !detail.data || detail.data.code === 'HOSTED_REQUEST_FAILED') throw error;
      return ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingDesired:fail'), {
        ...input,
        wakeId,
        ...detail.data,
      });
    }
  },
});
