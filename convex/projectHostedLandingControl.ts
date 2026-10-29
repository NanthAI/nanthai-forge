import { semanticVerdict, semanticConflictMessage } from '../src/intent-semantic-conflict';
import { digest } from '../src/portable-hash';
import { canonicalPayload } from '../src/hosted-source-operation';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import {
  landingQueue,
  loadLanding,
  loadLandingAttempt,
  writeLanding,
  settleLandingOperation,
  landingRow,
  type LandingChannel,
} from './projectHostedLandingStore';
import { scheduleLandingWake, releaseLandingQueue } from './projectHostedLandingWake';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { loadHostedCheck } from './projectHostedCheckStore';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import { hostedCheckTerminal } from '../src/hosted-check';
import { HOSTED_LANDING_LEASE_MS, landingObservation, type HostedLandingState } from '../src/hosted-landing';
import { ForgeError, invariant } from '../src/errors';
export type LandingClaim = LandingChannel & {
  owner: string;
  token: number;
  submissionId: string;
  attemptId: string;
};
/** Claim an original attempt and schedule its watchdog atomically. Expiry only
 * allows reconciliation; it never creates a new Candidate, run or provider call. */
export async function claimLandingQueue(
  ctx: MutationCtx,
  input: LandingChannel & { wakeId: string },
  now = Date.now(),
): Promise<LandingClaim | null> {
  const queue = await landingQueue(ctx, input);
  if (!queue) return null;
  if (queue.lease && queue.lease.until > now) {
    return queue.lease.owner === input.wakeId
      ? {
          projectId: input.projectId,
          channel: input.channel,
          owner: queue.lease.owner,
          token: queue.lease.token,
          submissionId: queue.lease.submissionId,
          attemptId: queue.lease.attemptId,
        }
      : null;
  }
  if (queue.wake?.id !== input.wakeId || queue.wake.at > now) return null;
  let row = queue.lease
    ? await landingRow(ctx, { projectId: input.projectId, submissionId: queue.lease.submissionId })
    : null;
  if (
    row &&
    (row.attemptId !== queue.lease!.attemptId || row.phase === 'terminal-failed' || row.phase === 'landed')
  )
    row = null;
  if (!row) {
    const selected = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('channel', input.channel).eq('runnable', true),
      )
      .order('asc')
      .take(1);
    row = selected[0] ?? null;
  }
  if (!row) {
    await ctx.db.patch(queue._id, { lease: null, wake: null });
    return null;
  }
  const lease = {
    owner: input.wakeId,
    token: queue.fence + 1,
    until: now + HOSTED_LANDING_LEASE_MS,
    submissionId: row.submissionId,
    attemptId: row.attemptId,
  };
  const selectedState = (
    await loadLanding(ctx, { projectId: input.projectId, submissionId: row.submissionId })
  ).state;
  await writeLanding(
    ctx,
    row,
    {
      ...selectedState,
      version: selectedState.version + 1,
      timing: {
        submittedAt: selectedState.at,
        ...selectedState.timing,
        selectedAt: selectedState.timing?.selectedAt ?? new Date(now).toISOString(),
      },
    },
    false,
  );
  await ctx.db.patch(queue._id, { fence: lease.token, lease, wake: null });
  await scheduleLandingWake(ctx, { ...queue, fence: lease.token, lease, wake: null }, lease.until, now);
  return {
    projectId: input.projectId,
    channel: input.channel,
    owner: lease.owner,
    token: lease.token,
    submissionId: lease.submissionId,
    attemptId: lease.attemptId,
  };
}
/** H14 must call this in the publication transaction before its independent
 * authority/main/receipt/policy/exact-run CAS. A lease is not acceptance evidence. */
export async function requireLandingLease(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const queue = await landingQueue(ctx, claim),
    lease = queue?.lease;
  invariant(
    queue &&
      lease &&
      lease.owner === claim.owner &&
      lease.token === claim.token &&
      lease.until > now &&
      lease.submissionId === claim.submissionId &&
      lease.attemptId === claim.attemptId,
    'WORK_STALE',
    'The hosted landing driver lease changed.',
  );
  const loaded = await loadLanding(ctx, claim);
  invariant(
    loaded.state.attemptId === claim.attemptId,
    'WORK_STALE',
    'A different landing attempt is current.',
  );
  const attempt = await loadLandingAttempt(ctx, claim);
  invariant(
    attempt.submissionId === loaded.state.id,
    'SOURCE_UNAVAILABLE',
    'Landing attempt belongs to another request.',
  );
  return { ...loaded, attempt, queue };
}
/** Metadata-only finite tick. Checks run through their existing durable identity
 * outside this transaction. Ready remains pending for H14; this never moves main. */
export async function advanceLandingQueue(ctx: MutationCtx, claim: LandingClaim, now = Date.now()) {
  const selected = await loadLanding(ctx, claim);
  const queue = await landingQueue(ctx, claim);
  if (
    selected.state.attemptId === claim.attemptId &&
    selected.state.phase !== 'queued' &&
    queue?.lease?.submissionId !== claim.submissionId
  )
    return selected.state;
  const { row, state, attempt, queue: held } = await requireLandingLease(ctx, claim, now);
  let phase: HostedLandingState['phase'] = 'ready',
    observation = landingObservation('queued');
  let error: HostedLandingState['error'] = null;
  try {
    await hostedWriteProject(ctx, claim.projectId, attempt.actor.id, attempt.authorityEpoch);
    const candidate = await readHostedRecord(ctx, {
      projectId: claim.projectId,
      actor: attempt.actor.id,
      kind: 'candidate',
      key: attempt.candidate.id,
    });
    invariant(
      candidate?.digest === attempt.candidate.digest,
      'EVIDENCE_CHANGED',
      'The original Candidate metadata differs.',
    );
    if (attempt.candidate.head === null) {
      phase = 'terminal-failed';
      observation = landingObservation('conflict');
      error = {
        code: 'COMPOSITION_CONFLICT',
        message: 'The pinned Candidate has retained source conflicts.',
      };
    } else if (attempt.check) {
      const check = attempt.check;
      const { run } = await loadHostedCheck(ctx, { projectId: claim.projectId, runId: check.runId });
      const progress = digest(
        canonicalPayload({
          id: run.id,
          status: run.status,
          counts: run.counts,
          plan: run.planDigest,
          execution: run.executionId,
          terminal: run.terminalDigest,
        }),
      );
      if (state.checkProgress !== progress) {
        state.checkProgress = progress;
        state.timing = { submittedAt: state.at, ...state.timing, ciProgressAt: new Date(now).toISOString() };
      }
      state.timing = {
        submittedAt: state.at,
        ...state.timing,
        checkReservedAt: run.at,
        ...(run.endedAt ? { ciEndedAt: run.endedAt } : {}),
        ...(run.status === 'running' && !state.timing?.ciObservedAt
          ? { ciObservedAt: new Date(now).toISOString() }
          : {}),
      };
      if (run.testFiles) state.testFiles = run.testFiles;
      const semantic = semanticVerdict(attempt.semanticPlan ?? run.semanticPlan, run.contractReports ?? {}, {
        candidateId: attempt.candidate.id,
        head: attempt.candidate.head,
        runId: run.id,
      });
      if (hostedCheckTerminal(run) && semantic.overBudget) {
        phase = 'terminal-failed';
        observation = landingObservation('failed', 'CONTRACT_OVER_BUDGET');
        error = {
          code: 'CONTRACT_OVER_BUDGET',
          message: `Composed contract union measured ${semantic.overBudget.measuredMs} ms; budget is under 90000 ms for Intents ${semantic.overBudget.intents.join(' + ')}.`,
        };
      } else if (['passed', 'failed'].includes(run.status) && semantic.conflicts.length) {
        phase = 'terminal-failed';
        observation = landingObservation('conflict');
        state.semanticConflicts = semantic.conflicts;
        error = { code: 'INTENT_SEMANTIC_CONFLICT', message: semanticConflictMessage(semantic.conflicts) };
      } else if (!hostedCheckTerminal(run)) {
        phase = 'checking';
        observation = landingObservation('checking');
      } else if (run.status !== 'passed') {
        phase = 'terminal-failed';
        observation = landingObservation(run.status);
        error = {
          code: run.status === 'failed' ? 'CHECK_FAILED' : 'CHECK_NOT_PASSED',
          message: `The original exact check settled as ${run.status}.`,
        };
      } else {
        await requireHostedCheckEvidence(ctx, {
          projectId: claim.projectId,
          runId: check.runId,
          actor: attempt.actor.id,
          candidateId: attempt.candidate.id,
          head: attempt.candidate.head,
          checkId: check.checkId,
          definition: check.definition,
          configuration: check.configuration,
          environment: check.environment,
          authorityEpoch: attempt.authorityEpoch,
        });
      }
    }
  } catch (cause) {
    // Unexpected/storage/scheduler failures abort and retain the watchdog. Only
    // structured domain outcomes settle this request, so later work can proceed.
    if (!(cause instanceof ForgeError)) throw cause;
    phase = 'terminal-failed';
    observation = landingObservation('failed', cause.code);
    error = { code: cause.code, message: cause.message };
  }
  if (phase === 'ready')
    state.timing = {
      submittedAt: state.at,
      ...state.timing,
      settlementStartedAt: state.timing?.settlementStartedAt ?? new Date(now).toISOString(),
    };
  if (phase === 'terminal-failed')
    state.timing = { submittedAt: state.at, ...state.timing, settledAt: new Date(now).toISOString() };
  const next = { ...state, version: state.version + 1, phase, observation, error };
  await writeLanding(ctx, row, next, false);
  if (phase === 'terminal-failed') await settleLandingOperation(ctx, next);
  await releaseLandingQueue(ctx, held, now);
  return next;
}
/** Event/startup repair for one named Channel; no project scan or empty poller. */
export async function recoverLandingQueue(ctx: MutationCtx, input: LandingChannel, now = Date.now()) {
  const queue = await landingQueue(ctx, input);
  if (!queue) return false;
  const pending = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_runnable_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', input.channel).eq('runnable', true),
    )
    .take(1);
  if (!pending.length && !queue.lease) return false;
  await scheduleLandingWake(
    ctx,
    queue,
    queue.lease && queue.lease.until > now ? queue.lease.until : now,
    now,
  );
  return true;
}

/** H14's constant-size final transaction can claim a prepared request directly.
 * This does no publication and cannot replace a live competing lease. */
export async function claimReadyLanding(
  ctx: MutationCtx,
  input: LandingChannel & {
    submissionId: string;
    attemptId: string;
    owner: string;
  },
  now = Date.now(),
): Promise<LandingClaim | null> {
  const queue = await landingQueue(ctx, input);
  invariant(queue, 'NOT_FOUND', 'Hosted landing queue not found.');
  const { state } = await loadLanding(ctx, input);
  invariant(
    state.phase === 'ready' && state.attemptId === input.attemptId,
    'WORK_STALE',
    'Select the current prepared landing attempt.',
  );
  if (queue.lease && queue.lease.until > now) {
    return queue.lease.owner === input.owner &&
      queue.lease.submissionId === input.submissionId &&
      queue.lease.attemptId === input.attemptId
      ? { ...input, token: queue.lease.token }
      : null;
  }
  if (queue.wake) await ctx.scheduler.cancel(queue.wake.taskId);
  const lease = {
    owner: input.owner,
    token: queue.fence + 1,
    until: now + HOSTED_LANDING_LEASE_MS,
    submissionId: input.submissionId,
    attemptId: input.attemptId,
  };
  await ctx.db.patch(queue._id, { fence: lease.token, lease, wake: null });
  await scheduleLandingWake(ctx, { ...queue, fence: lease.token, lease, wake: null }, lease.until, now);
  return { ...input, token: lease.token };
}
