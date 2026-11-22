// SPDX-License-Identifier: Apache-2.0
import { latestCancelledRun, supersededCheckCosts } from './projectHostedLandingRunnerCosts';
import { withoutAuthorship, personStampValid } from '../src/work-actor-types';
import { cancelPendingTask } from './schedulerCancel';
import { recordLandingFeed } from './projectFeedTerminal';
import { chargeMemberWork, memberWorkBudgetReply } from './abuseLimits';
import { landingPriority } from './projectHostedLandingOrder';
import { scheduleLandingAlarm } from './projectHostedLandingStallWake';
import { desiredWatchdogMs } from '../src/hosted-landing-stall';
import { desiredLanding, scheduleDesired as schedule } from './projectHostedLandingDesiredWake';
import { landGateGuardEvidence, landGateTiming } from '../src/hosted-land-gates';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { receiptMutation, internalMutation, internalAction, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import { acceptanceActor } from './projectAutonomy';
import { landingAgentClient, landingAgentRun } from '../src/agent-slug';
import { activeProject } from './projectAuthority';
import { landingGrantStamp } from './accessPolicy';
import { requireWriteEpoch } from './projectHostedRecords';
import { loadCompose } from './projectHostedComposeStore';
import { repairConvexSource } from './projectConvexSourceStore';
import { enqueueHostedLanding } from './projectHostedLanding';
import { replaceOwnerlessLanding } from './projectHostedLaneFinish';
import { landingAlias } from './projectHostedLandingIdentity';
import { failedLanding, landingRow, type LandingRow } from './projectHostedLandingStore';
import { notifyStackedLandingEnded } from './projectHostedStackNotice';
import { enforceLandGates } from './projectHostedLandGates';
import { requireQueueRoom } from './projectHostedQueueRoom';
import { hostedLandingDesiredSchema } from '../src/hosted-landing-desired';
import { validateNotVerified } from '../src/agent-handoff-types';
import {
  storedLandingStateSchema,
  landingHoldMs,
  landingObservation,
  landingTokensColumn,
} from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import { sanitizeOutside, declarationIdentity } from '../src/run-evidence';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { heldReview } from './projectHostedOwnerReview';
import { landingMessageForReader, landingWithoutClientHold } from './projectHostedLandingMessageBody';
import { crossHeadProofSchema } from '../src/hosted-cross-head-proof';
import type { GithubInboundProof } from './projectGithubPullReuse';
import { checkRequest } from './projectGithubCheckRequest';

const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
/** Register the goal while the first source job runs. The selected source pages
 * are already staged; no Mac, client journal or further client mutation is needed. */
export const submit = receiptMutation({
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
     * for a new submission only, and not part of the request. */
    maxChecks: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const tokens = landingTokensColumn(input.tokens);
      const heldMs = landingHoldMs(input.heldMs);
      const command = hostedLandingDesiredSchema.parse(JSON.parse(input.request));
      validateNotVerified(command.notVerified);
      const actor = await acceptanceActor(ctx, true);
      const reply = memberWorkBudgetReply(
        ctx,
        { projectId: input.projectId, actor: actor.id },
        'landing',
        input.memberBudget,
      );
      const state = await submitDesiredLanding(
        ctx,
        input.projectId,
        command,
        actor,
        input.agent,
        input.agentClient,
        { value: input.gates },
        tokens.agentTokens,
        input.maxChecks,
        true,
        heldMs,
      );
      return reply(state);
    } catch (error) {
      return report(error);
    }
  },
});
/** The desired-landing submit for an already authenticated (or trusted system) actor; the
 * public mutation and two-way GitHub sync (convex/projectGithubInbound.ts) share it. */
export async function submitDesiredLanding(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  inputCommand: z.infer<typeof hostedLandingDesiredSchema> & {
    githubProof?: GithubInboundProof;
  },
  actor: { id: string; kind: 'agent' | 'person' },
  agent?: string,
  agentClient?: string,
  /** Public submit only: judge the project land gates (two-way GitHub sync is not an agent landing). */
  gates?: { value: string | undefined },
  /** Public submit only: the agent's reported tokens, already range-checked (landingTokensColumn). */
  agentTokens?: number,
  /** Public submit only: `land {maxChecks}` (convex/projectHostedQueueRoom.ts). */
  maxChecks?: number,
  includeReview = false,
  heldMs?: number,
): Promise<string> {
  const { githubProof, ...requestCommand } = inputCommand;
  const command =
    requestCommand.outside === undefined
      ? requestCommand
      : { ...requestCommand, outside: sanitizeOutside(requestCommand.outside) };
  const input = { projectId, agent, agentClient };
  invariant(
    personStampValid({ ...command, agentClient, agentRun: agent }),
    'BAD_ARGUMENT',
    'A person stamp has no model or run.',
  );
  // The epoch is checked only for a new desired landing, as beginHostedOperation does: a replay of
  // one that began at an older epoch reads its record back instead of a refusal on every try (N3,
  // Item 1d69905b). The project read and its access check stay first.
  const project = await activeProject(ctx, input.projectId, actor.id);
  // Only reused canonical states can be held. Project the current approval on the public reply,
  // leaving the stored state bytes intact and every fresh submission on its existing path.
  const reply = async (row: Pick<LandingRow, 'value'> & { phase?: LandingRow['phase'] }) => {
    const state = JSON.parse(row.value) as z.infer<typeof storedLandingStateSchema>;
    const review = includeReview && row.phase === 'ready' ? await heldReview(ctx, project, state) : null;
    const visible = heldMs === undefined ? landingWithoutClientHold(state) : state;
    if (!review && !state.messageRef && visible === state) return row.value;
    const selected = await landingMessageForReader(ctx, projectId, visible);
    return canonicalPayload(review ? { ...selected, ...review } : selected);
  };
  const request = canonicalPayload(withoutAuthorship(command));
  const old = await ctx.db
    .query('projectHostedLandingDesired')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', actor.id).eq('operationId', command.operationId),
    )
    .unique();
  if (old) {
    invariant(old.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original desired landing.');
    const canonical = await landingRow(ctx, old);
    if (!canonical && old.wake) {
      const task = await ctx.db.system.get(old.wake.taskId);
      if (!task || task.state.kind === 'failed') await schedule(ctx, old, 0);
    }
    return reply(canonical ?? old);
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
    return reply(canonical ?? desired!);
  }
  requireWriteEpoch(project, command.authorityEpoch);
  // Fresh goals and fresh aliases charge once; canonical admission retains this reservation.
  await chargeMemberWork(ctx, project, actor.id, 'submissions');
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
  const { grant } = landingGrantStamp(ctx);
  const selectionKey = digest(
    canonicalPayload({
      channel: 'main',
      ...declarationIdentity(command, actor.id),
      message: command.message ?? null,
      ...(command.priority === 'urgent' ? { priority: 'urgent' } : {}),
      agent: true,
      check: command.check,
      inputs: source.state.request.inputs.root,
      dependencies: source.state.request.dependencies.root,
      after: command.after,
      // A folder-grant goal joins only work under the same grant; other keys are unchanged (df06081d).
      ...(grant ? { grant } : {}),
    }),
  );
  const [queued] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_selection', q =>
      q.eq('projectId', input.projectId).eq('selectionKey', selectionKey),
    )
    .order('desc')
    .take(1);
  let queuedState = queued && storedLandingStateSchema.parse(JSON.parse(queued.value));
  const replaced = queued && (await replaceOwnerlessLanding(ctx, queued));
  if (replaced)
    queuedState = storedLandingStateSchema.parse(JSON.parse((await landingRow(ctx, queued))!.value));
  if (queued && queuedState?.phase !== 'terminal-failed') {
    await ctx.db.insert('projectHostedLandingAliases', {
      projectId: input.projectId,
      actor: actor.id,
      operationId: command.operationId,
      requestHash: digest(request),
      submissionId: queued.submissionId,
    });
    return reply(queued);
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
    existing && storedLandingStateSchema.parse(JSON.parse(existingCanonical?.value ?? existing.value));
  if (
    existing &&
    existingState?.phase !== 'terminal-failed' &&
    !(existingCanonical && (await replaceOwnerlessLanding(ctx, existingCanonical)))
  ) {
    await ctx.db.insert('projectHostedLandingAliases', {
      projectId: input.projectId,
      actor: actor.id,
      operationId: command.operationId,
      requestHash: digest(request),
      submissionId: existing.submissionId,
    });
    return reply(existingCanonical ?? existing);
  }
  // A new desired landing only: replays and joins of a live landing above return unjudged.
  await requireQueueRoom(ctx, input.projectId, maxChecks);
  if (gates)
    await enforceLandGates(ctx, {
      projectId: input.projectId,
      project,
      actor,
      composeOperationId: command.composeOperationId,
      gates: gates.value,
    });
  const previous = queuedState ?? existingState;
  // Every live selection returned above. A replaced ownerless selection can still have its
  // pre-cancellation phase here; its already-loaded counts are the same terminal predecessor's.
  const previousAccounting = (queuedState ? queued : (existingCanonical ?? existing))?.runnerAccounting;
  const carried = previous
    ? supersededCheckCosts(
        previous,
        queuedState
          ? (queued?.runId ?? queued?.admission?.runId)
          : (existingCanonical?.runId ?? existingCanonical?.admission?.runId),
        queuedState
          ? queued?.supersededCheck
          : existingCanonical
            ? existingCanonical.supersededCheck
            : existing?.supersededCheck,
        latestCancelledRun(ctx, queuedState ? queued : (existingCanonical ?? undefined)) ??
          previousAccounting?.lastCancelled,
      )
    : undefined;
  const id = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    at = new Date().toISOString();
  const state = storedLandingStateSchema.parse({
    schema: 1,
    projectId: input.projectId,
    id,
    operationId: command.operationId,
    actor: actor.id,
    at,
    sequence: 0,
    ...landingPriority(project, actor, command.priority),
    priorityVersion: 0,
    version: 0,
    firstAttemptId: attemptId,
    attemptId,
    phase: 'composing',
    preparing: true,
    ...(previous
      ? { supersedes: previous.id, retryReason: command.retryReason ?? 'other', counts: carried!.counts }
      : {}),
    observation: landingObservation('queued'),
    error: null,
    timing: {
      submittedAt: at,
      composeStartedAt: source.operation.firstAttempt.at,
      ...landGateTiming(gates?.value),
      ...(heldMs === undefined ? {} : { heldMs }),
    },
    request: {
      ...(command.authorship ? { authorship: command.authorship } : {}),
      ...(command.governanceVersion ? { governanceVersion: command.governanceVersion } : {}),
      operationId: command.operationId,
      authorityEpoch: command.authorityEpoch,
      channel: 'main',
      ...(command.message === undefined ? {} : { message: command.message }),
      ...(command.notVerified === undefined ? {} : { notVerified: command.notVerified }),
      ...(command.outside === undefined ? {} : { outside: command.outside }),
      expectedMain: source.state.request.expectedMain,
      candidateId: source.state.candidateId,
      expectedHead: null,
      agent: true,
      ...(command.priority ? { priority: command.priority } : {}),
      check: command.check,
      ...(command.retryReason ? { retryReason: command.retryReason } : {}),
      ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
      ...(command.closes === undefined ? {} : { closes: command.closes }),
      ...(command.revertOf ? { revertOf: command.revertOf } : {}),
      finish: { composeOperationId: command.composeOperationId, after: command.after },
    },
  });
  const key = await ctx.db.insert('projectHostedLandingDesired', {
    ...(githubProof ? { githubProof: canonicalPayload(githubProof) } : {}),
    runnerAccounting: previousAccounting ?? { root: id, pending: 0 },
    ...(carried?.supersededCheck ? { supersededCheck: carried.supersededCheck } : {}),
    preparing: true,
    projectId: input.projectId,
    actor: actor.id,
    operationId: command.operationId,
    submissionId: id,
    composeOperationId: command.composeOperationId,
    selectionKey,
    request,
    value: canonicalPayload(state),
    // The enqueue below receives this row as its input and copies the run to the landing row.
    ...landingAgentRun(input.agent),
    ...landingAgentClient(input.agentClient),
    // A folder-grant device's grant, from the row the guard read (df06081d); checked when the goal enqueues.
    ...(grant ? { grant } : {}),
    ...(agentTokens === undefined ? {} : { agentTokens }),
    ...landGateGuardEvidence(gates?.value),
    wake: null,
  });
  // A source job still running cannot finish this goal: its completion wakes
  // the goal at once (notifyDesiredCompose), so an immediate drive would claim
  // and advance to nothing. Arm the same watchdog that drive's claim would
  // have armed a moment later; terminal sources still drive immediately.
  const running = source.state.status === 'submitted' && !source.operation.terminal;
  await schedule(ctx, (await ctx.db.get(key))!, running ? desiredWatchdogMs(state) : 0);
  await scheduleLandingAlarm(ctx, state);
  return canonicalPayload(state);
}
/** Claim and advance are separate transactions: a killed action leaves a fenced
 * watchdog. Only pending goals own a timer; source publication also wakes them. */
export const claim = internalMutation({
  args: { ...identity, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = storedLandingStateSchema.parse(JSON.parse(row.value));
    if (state.observation.state !== 'pending') {
      // This is the wake currently running; Convex refuses self/ancestor cancellation.
      await ctx.db.patch(row._id, { wake: null });
      return null;
    }
    // Replace the fence without canceling the action that called this mutation.
    return schedule(ctx, { ...row, wake: null }, desiredWatchdogMs(state));
  },
});
export const advance = internalMutation({
  args: { ...identity, wakeId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = storedLandingStateSchema.parse(JSON.parse(row.value));
    try {
      await activeProject(ctx, row.projectId, row.actor);
      const source = await loadCompose(ctx, {
        projectId: row.projectId,
        actor: row.actor,
        operationId: row.composeOperationId,
      });
      const terminal = source.operation.terminal;
      if (!terminal) {
        // The watchdog resumes a source step whose worker died or was fenced (incident e62d834b),
        // only once its worker lease has expired; a running or pending step holds a live lease and is
        // left alone. It never fails this goal: the next wake retries.
        if (source.row.jobId) await repairSource(ctx, row.projectId, source.row.jobId);
        return null;
      }
      if (terminal.outcome.status === 'failed')
        throw new ForgeError(terminal.outcome.error.code, terminal.outcome.error.message);
      const candidate = hostedRecordSchema.options[3].parse(terminal.outcome.result);
      const inbound = row.githubProof ? (JSON.parse(row.githubProof) as GithubInboundProof) : null;
      const githubProof = inbound ? crossHeadProofSchema.safeParse(inbound.proof) : null;
      const result = await enqueueHostedLanding(
        ctx,
        row,
        {
          ...state.request,
          ...(row.githubProof ? { check: await checkRequest(ctx, row.projectId) } : {}),
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
          counts: state.counts,
          supersededCheck: row.supersededCheck,
          runnerAccounting: row.runnerAccounting,
          ...(inbound && githubProof?.success && githubProof.data.algorithm === 'exact-tree-v1'
            ? { githubProof: { ...inbound, proof: githubProof.data } }
            : {}),
        },
      );
      await cancelPendingTask(ctx, row.wake?.taskId);
      await ctx.db.patch(row._id, {
        value: canonicalPayload(result),
        wake: null,
        preparing: undefined,
        ...(row.githubProof ? { githubProof: undefined } : {}),
        supersededCheck: undefined,
      });
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
async function repairSource(ctx: MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) {
  try {
    await repairConvexSource(ctx, { projectId, jobId }, { expiredOnly: true });
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
  }
}
/** Admission failures roll back their whole transaction before this independent
 * failure publication. A failed check reservation cannot leave a partial queue. */
export const fail = internalMutation({
  args: { ...identity, wakeId: v.string(), code: v.string(), message: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await desiredLanding(ctx, input);
    if (row?.wake?.id !== input.wakeId) return null;
    const state = storedLandingStateSchema.parse(JSON.parse(row.value));
    const failed = {
      ...state,
      version: state.version + 1,
      phase: 'terminal-failed' as const,
      timing: { submittedAt: state.at, ...state.timing, settledAt: new Date().toISOString() },
      observation: landingObservation('failed', input.code),
      error: { code: input.code, message: input.message },
    };
    await cancelPendingTask(ctx, row.wake?.taskId);
    await scheduleLandingAlarm(ctx, failed);
    await ctx.db.patch(row._id, { value: canonicalPayload(failed), wake: null, preparing: undefined });
    await recordLandingFeed(ctx, failed);
    await failedLanding(ctx, failed);
    // This failure never reaches writeLanding: Lanes stacked on the Lanes it carried are told here (dc62b120).
    await notifyStackedLandingEnded(ctx, {
      projectId: row.projectId,
      actor: state.actor,
      composeOperationId:
        state.request.finish?.composeOperationId ?? state.request.finish?.reviewedSource?.operationId,
      operationId: state.operationId,
      code: input.code,
    });
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
          ? storedLandingStateSchema.shape.error.safeParse(error.data)
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
