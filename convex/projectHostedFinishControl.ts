// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { exhaustFinishCompose } from './projectHostedComposeExhaustion';
import { loadBatch, writeBatch, wakeBatch } from './projectHostedLandingBatchStore';
import { batchFinishStep, resumeBatchIO } from './projectHostedLandingBatchFinish';
import { publishLandingBatch } from './projectHostedLandingBatchPublish';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import { loadFinish, failFinish } from './projectHostedFinishStore';
import {
  loadLanding,
  loadLandingAttempt,
  writeLanding,
  type LandingIdentity,
} from './projectHostedLandingStore';
import { retryFinish, scheduleFinish, watchFinishCompose } from './projectHostedFinishWake';
import { prepareFinishCompose, installFinishCompose, reserveFinishRetry } from './projectHostedFinishCompose';
import { hostedComposeInput } from './projectHostedComposeStore';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { prepareAcceptance, stageAcceptance } from './projectHostedAcceptanceStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { landingQueue } from './projectHostedLandingStore';
import { claimReadyLanding } from './projectHostedLandingControl';
import {
  laneRefusalCohort,
  refuseStaleLaneProofNow,
  wakeAfterLaneRefusal,
} from './projectHostedLandingEarlyRefusal';
import { publishAcceptance } from './projectHostedAcceptancePublish';
import { hostedWriteProject } from './projectHostedRecords';
import { blobStore } from './blobStore';
import { presignGet, r2Config, r2Key } from './r2';
import { isStored } from './projectObjectFields';
import { canonicalPayload } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { landingObservation } from '../src/hosted-landing';
import type { FinishCommand } from '../src/hosted-finish';
import { culpritId } from '../src/culprit-bisect';
import { ForgeError, invariant } from '../src/errors';
import { reuseDecision } from './projectHostedReuseStore';
import { findObject, ownRow } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { ownerReviewFiles } from './projectHostedOwnerGrant';
import { reviewProtect } from '../src/protected-review';
import { effectivePolicy } from '../src/autonomy-policy';
import { protectedCarryReview, settleProtectedCarry } from './projectHostedOwnerGrantCarry';
import { releaseApprovedReview } from './projectHostedOwnerReview';
export type FinishIdentity = LandingIdentity & { wakeId: string; attempt?: number };
export async function finishStep(ctx: MutationCtx, input: FinishIdentity): Promise<FinishCommand | null> {
  const { row, value } = await loadFinish(ctx, input);
  if (row.wake?.id !== input.wakeId || row.wake.at > Date.now()) return null;
  // A completed/lost reply never permits an older IO callback to advance later work.
  await ctx.db.patch(row._id, { wake: null });
  const { row: landing, state } = await loadLanding(ctx, input);
  try {
    if (!value.pending?.precompose) {
      const batchStep = await batchFinishStep(ctx, input, row);
      if (batchStep.handled) return batchStep.command;
    }
    if (state.phase === 'landed' || state.phase === 'terminal-failed') return null;
    const reviewHeld = landing.earlyReview && state.observation.pendingReason === 'waiting-for-review';
    const project = await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
    if (value.recoveryRunId) {
      const audit = await ctx.db
        .query('projectHostedMainAudits')
        .withIndex('by_project', q => q.eq('projectId', input.projectId))
        .unique();
      if (
        !audit?.red ||
        (culpritId({ redEpisode: audit.red.since }) !== value.recoveryRunId &&
          audit.red.runId !== value.recoveryRunId)
      ) {
        await failFinish(
          ctx,
          input,
          'RECOVERY_SUPERSEDED',
          'The red audit was superseded; no automatic reverse was landed. The saved reverse Lane remains available.',
        );
        await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:advance'), {
          projectId: input.projectId,
          runId: value.recoveryRunId,
        });
        return null;
      }
    }
    if (row.parentSubmissionId) {
      const parent = (
        await loadLanding(ctx, { projectId: input.projectId, submissionId: row.parentSubmissionId })
      ).state;
      if (parent.phase !== 'landed') {
        if (parent.phase === 'terminal-failed')
          await failFinish(ctx, input, 'DEPENDENCY_NOT_LANDED', 'The pinned parent submission did not land.');
        else if (!reviewHeld && state.observation.pendingReason !== 'waiting-for-dependency')
          await writeLanding(
            ctx,
            landing,
            {
              ...state,
              version: state.version + 1,
              observation: landingObservation('waiting-for-dependency'),
            },
            landing.runnable,
          );
        return null;
      }
      await ctx.db.patch(row._id, { waiting: false });
    }
    if (value.pending) {
      const source = await prepareFinishCompose(ctx, input, value);
      if (source.operation.terminal) {
        if (row.reuseLease?.pendingId === value.pending.id) {
          if (row.reuseLease.until > Date.now()) {
            await retryFinish(ctx, row, input, row.reuseLease.until - Date.now(), true);
          } else {
            // Unknown proof outcome: one ordinary exact check, never a second
            // simultaneous analysis. Late callbacks are fenced by pending ID.
            await installFinishCompose(ctx, row, value, undefined, source, 'analysis-expired');
          }
          return null;
        }
        if (
          !value.pending.precompose &&
          landing.ownerGrant &&
          (landing.earlyReview || landing.ownerGrant.held || landing.ownerGrant.candidateDigest === undefined)
        ) {
          const files =
            source.operation.terminal.outcome.status === 'completed'
              ? await ownerReviewFiles(ctx, landing, source.state.candidateId)
              : null;
          if (files) {
            await retryFinish(ctx, row, input);
            // Item fe2b0a86: a hold about protected paths alone binds only those entries. A folder-grant
            // landing keeps the whole-list rule: the owner's acceptance also stands in for its grant check.
            const protect = landing.grant
              ? undefined
              : reviewProtect(
                  project,
                  effectivePolicy(project),
                  state.actor,
                  files.paths,
                  project.checkEntries,
                );
            return {
              kind: 'review',
              pendingId: value.pending.id,
              approvedAttemptId: landing.ownerGrant.attemptId,
              candidateDigest: files.digest,
              before: files.before,
              after: files.after,
              ...(protect ? { protect } : {}),
            };
          }
          await installFinishCompose(ctx, row, value, undefined, source);
          return null;
        }
        const decision = value.pending.precompose ? null : await reuseDecision(ctx, input);
        if (decision && !('reason' in decision)) {
          await retryFinish(ctx, row, input);
          return { kind: 'reuse', pendingId: value.pending.id };
        }
        await installFinishCompose(
          ctx,
          row,
          value,
          undefined,
          source,
          decision?.reason,
          undefined,
          decision?.reason === 'audit-baseline' ? false : undefined,
        );
        return null;
      }
      if (source.state.status === 'submitted') {
        // This path is explicit pending-operation repair: reconcile the same job
        // or reschedule its terminal publication, never allocate replacement work.
        await submitHostedCompose(ctx, {
          projectId: input.projectId,
          actor: state.actor,
          operationId: value.pending.operations.compose,
        });
        await watchFinishCompose(ctx, row._id, value.pending.at, async () =>
          exhaustFinishCompose(ctx, (await ctx.db.get(row._id))!, value.pending!.operations.compose),
        );
        return null;
      }
      const plan = canonicalPayload(hostedComposeInput(source.state, source.operation.firstAttempt.at));
      const pin = savePin(JSON.parse(plan));
      const object = await findObject(ctx, input.projectId, pin.sha256);
      if (object && !object.removed && object.size === pin.size && isStored(object)) {
        await submitHostedCompose(ctx, {
          projectId: input.projectId,
          actor: state.actor,
          operationId: value.pending.operations.compose,
        });
        await watchFinishCompose(ctx, row._id, value.pending.at, async () =>
          exhaustFinishCompose(ctx, (await ctx.db.get(row._id))!, value.pending!.operations.compose),
        );
        return null;
      }
      r2Config();
      const key = r2Key(input.projectId, pin.sha256);
      if (!object)
        await ctx.db.insert('projectObjects', {
          projectId: input.projectId,
          digest: pin.sha256,
          size: pin.size,
          nonce: crypto.randomUUID(),
          removed: false,
          location: 'r2',
          r2Key: key,
        });
      else {
        invariant(
          !object.removed && object.size === pin.size,
          'SOURCE_HASH_MISMATCH',
          'Source plan binding differs.',
        );
        await ctx.db.patch(ownRow(object)._id, { location: 'r2', r2Key: key });
      }
      await retryFinish(ctx, row, input);
      // Item 9a04d916: a settle hands the action this compose, never the plan bytes.
      return {
        kind: 'plan',
        value: plan,
        pin,
        source: {
          actor: state.actor,
          operationId: value.pending.operations.compose,
          at: source.operation.firstAttempt.at,
        },
      };
    }
    if (state.phase !== 'ready' && !reviewHeld) return null; // H13's run/queue events resume it
    // Item fe2b0a86 part B: a held landing that may reuse an earlier owner approval of the same Intent
    // compares its protected entries once per Candidate (one listing pair), then lifts only that reason.
    if (
      reviewHeld &&
      landing.protectedCarry &&
      landing.protectedCarry.settled !== state.attemptId &&
      !landing.ownerGrant
    ) {
      const attempt = await loadLandingAttempt(ctx, {
        projectId: input.projectId,
        attemptId: state.attemptId,
      });
      const review = await protectedCarryReview(ctx, landing, attempt, project);
      if (review) {
        await retryFinish(ctx, row, input);
        return {
          kind: 'protected',
          attemptId: attempt.id,
          candidateDigest: attempt.candidate.digest,
          ...review,
        };
      }
    }
    if (
      state.batchNeedsSoloCompose &&
      !state.batchOriginId &&
      landing.pipelineRetiredAttemptId === state.attemptId
    ) {
      await reserveFinishRetry(ctx, row, value, 'BATCH_FALLBACK');
      return null;
    }
    const selection = { ...input, attemptId: state.attemptId };
    const plan = await prepareAcceptance(ctx, selection);
    const kind = plan.inputsNext ? 'inputs' : 'dependencies';
    const pin = plan.inputsNext ?? plan.dependenciesNext;
    if (pin) {
      const object = await findObject(ctx, input.projectId, pin.sha256);
      invariant(
        object && !object.removed && object.size === pin.size && isStored(object),
        'SOURCE_UNAVAILABLE',
        'Exact acceptance metadata is unavailable.',
      );
      const url =
        object.location === 'r2' && object.r2Key
          ? await presignGet(r2Config(), object.r2Key, packHeaders(packRange(object), object.size))
          : object.storageId
            ? await blobStore(ctx).getUrl(object.storageId)
            : null;
      invariant(url, 'SOURCE_UNAVAILABLE', 'Exact acceptance metadata is unavailable.');
      await retryFinish(ctx, row, input);
      return {
        kind: 'page',
        url,
        ...(object.pack ? { range: packRange(object)! } : {}),
        pin,
        selection: {
          attemptId: state.attemptId,
          kind,
          index: kind === 'inputs' ? plan.inputPages : plan.dependencyPages,
        },
      };
    }
    if (reviewHeld) return null;
    const claim = await claimReadyLanding(
      ctx,
      { ...selection, channel: 'main', owner: plan.receiptId },
      Date.now(),
      false,
    );
    if (!claim) {
      await scheduleFinish(ctx, (await ctx.db.get(row._id))!, 250);
      return null;
    }
    // An older submission takes main first; its next transition wakes this finish,
    // or the end of its hold when nothing dispatches it yet (one wake, no poll).
    if ('waitingFor' in claim) {
      // A certainly stale Lane proof recomposes now, beside the refused peers
      // ahead of it, instead of after each of them in turn.
      const early = await refuseStaleLaneProofNow(ctx, { row: landing, state, waitingOn: claim.ahead });
      if (early) {
        // Recomposing writes the entry queued, which clears its order wait.
        await reserveFinishRetry(ctx, (await ctx.db.get(row._id))!, value);
        await wakeAfterLaneRefusal(ctx, input, early);
        return null;
      }
      if (claim.until !== null)
        await scheduleFinish(ctx, (await ctx.db.get(row._id))!, Math.max(0, claim.until - Date.now()));
      return null;
    }
    try {
      if (state.batchId && !state.batchSolo) await publishLandingBatch(ctx, claim);
      else await publishAcceptance(ctx, claim);
    } catch (error) {
      if (
        error instanceof ForgeError &&
        (['CHANNEL_CHANGED', 'CHECK_EVIDENCE_REFRESH'].includes(error.code) ||
          (landing.earlyReview && landing.ownerGrant && error.code === 'POLICY_CHANGED') ||
          (landing.githubInboundProof &&
            state.attemptId === state.firstAttemptId &&
            ['EVIDENCE_CHANGED', 'NOT_FOUND', 'POLICY_CHANGED'].includes(error.code)))
      ) {
        // Yield the Channel so later independent runnable requests can advance.
        const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
        if (queue) await releaseLandingQueue(ctx, queue);
        // A policy change names the pinned digest it outdated (the attempt pin is cached).
        const policy =
          error.code === 'POLICY_CHANGED'
            ? {
                kind: 'policy' as const,
                link: (
                  await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId })
                ).policyDigest,
              }
            : undefined;
        await reserveFinishRetry(
          ctx,
          (await ctx.db.get(row._id))!,
          value,
          undefined,
          undefined,
          undefined,
          policy,
        );
        const cohort =
          error.code === 'CHANNEL_CHANGED' ? await laneRefusalCohort(ctx, { row: landing, state }) : null;
        if (cohort) await wakeAfterLaneRefusal(ctx, input, cohort);
      } else throw error;
    }
    return null;
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    if (state.batchId && !state.batchSolo) {
      const key = { projectId: input.projectId, batchId: state.batchId };
      const { batch } = await loadBatch(ctx, key);
      if (batch.phase === 'composing' || batch.phase === 'checking') {
        await writeBatch(ctx, key, {
          ...batch,
          phase: 'fallback',
          transition: { code: error.code, message: error.message },
        });
        await wakeBatch(ctx, key);
        const held = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
        if (held?.lease?.submissionId === input.submissionId) await releaseLandingQueue(ctx, held);
        return null;
      }
    }
    await failFinish(ctx, input, error.code, error.message);
    const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    if (queue?.lease?.submissionId === input.submissionId) await releaseLandingQueue(ctx, queue);
    return null;
  }
}
/** One exact IO completion; duplicate or delayed generations do nothing. */
async function resumeFinishIOOnce(
  ctx: MutationCtx,
  input: FinishIdentity & { command: FinishCommand; page?: unknown; storageId?: string; key?: string },
) {
  const { row, value } = await loadFinish(ctx, input);
  invariant(
    input.command.kind !== 'reuse',
    'WORK_OPERATION_CHANGED',
    'Proof completion uses its internal source verifier.',
  );
  if (row.wake?.id !== input.wakeId) return;
  const { row: landing, state } = await loadLanding(ctx, input);
  if (input.command.kind === 'plan' && input.command.batchId) {
    await resumeBatchIO(ctx, { ...input, command: input.command });
    return;
  }
  if (state.phase === 'landed' || state.phase === 'terminal-failed') return;
  await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
  if (input.command.kind === 'review') {
    const command = input.command;
    if (
      value.pending?.id !== command.pendingId ||
      landing.ownerGrant?.attemptId !== command.approvedAttemptId
    )
      return;
    await cancelPendingTask(ctx, row.wake.taskId);
    await ctx.db.patch(row._id, { wake: null });
    await installFinishCompose(
      ctx,
      row,
      value,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // auditDonor
      input.page === true ? command.candidateDigest : undefined,
    );
    return;
  }
  if (input.command.kind === 'protected') {
    const command = input.command;
    if (
      value.pending ||
      state.attemptId !== command.attemptId ||
      !landing.protectedCarry ||
      landing.ownerGrant
    )
      return;
    await cancelPendingTask(ctx, row.wake.taskId);
    await ctx.db.patch(row._id, { wake: null });
    const same = input.page === true;
    await settleProtectedCarry(
      ctx,
      landing,
      command.attemptId,
      command.candidateDigest,
      same ? command.paths : undefined,
    );
    // The same release as an owner approval: the entry returns to its check and turn, and publication
    // lifts only the protected reason for this exact Candidate (carriedProtectedPaths).
    if (same) await releaseApprovedReview(ctx, input);
    await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
    return;
  }
  if (input.command.kind === 'page') {
    invariant(
      !value.pending && input.command.selection.attemptId === state.attemptId,
      'WORK_STALE',
      'Resume only the pending acceptance attempt.',
    );
    await stageAcceptance(ctx, { ...input, ...input.command.selection, page: input.page });
  } else {
    invariant(
      value.pending && (input.storageId || input.key),
      'WORK_STALE',
      'Resume only the pending composition.',
    );
    const source = await prepareFinishCompose(ctx, input, value);
    const plan = hostedComposeInput(source.state, source.operation.firstAttempt.at),
      pin = savePin(plan);
    invariant(
      canonicalPayload(pin) === canonicalPayload(input.command.pin) &&
        canonicalPayload(plan) === input.command.value,
      'WORK_OPERATION_CHANGED',
      'Upload only the original pending source plan.',
    );
    const old = await findObject(ctx, input.projectId, pin.sha256);
    invariant(
      !old || (!old.removed && old.size === pin.size),
      'SOURCE_HASH_MISMATCH',
      'Source plan binding differs.',
    );
    if (input.key) {
      invariant(
        old &&
          old.location === 'r2' &&
          old.r2Key === input.key &&
          input.key === r2Key(input.projectId, pin.sha256),
        'SOURCE_HASH_MISMATCH',
        'Resume the exact reserved R2 source plan.',
      );
      // A stored entry already holds the flag: never copy it into a row to set it again.
      if (!old.r2Committed) await ctx.db.patch(ownRow(old)._id, { r2Committed: true });
    } else {
      // Read-only compatibility for an already-issued legacy IO callback.
      const metadata = await blobStore(ctx).getMetadata(input.storageId!);
      invariant(
        metadata?.sha256 === pin.sha256 && metadata.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Uploaded source plan differs from its exact bytes.',
      );
      const storageId = input.storageId as import('./_generated/dataModel').Id<'_storage'>;
      if (!old)
        await ctx.db.insert('projectObjects', {
          projectId: input.projectId,
          digest: pin.sha256,
          size: pin.size,
          storageId,
          nonce: crypto.randomUUID(),
          removed: false,
        });
      else if (!isStored(old)) await ctx.db.patch(ownRow(old)._id, { storageId });
    }
    await submitHostedCompose(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      operationId: value.pending.operations.compose,
    });
  }
  await cancelPendingTask(ctx, row.wake?.taskId);
  await ctx.db.patch(row._id, { wake: null });
  if (input.command.kind === 'page') await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
  else
    await watchFinishCompose(ctx, row._id, value.pending!.at, async () =>
      exhaustFinishCompose(ctx, (await ctx.db.get(row._id))!, value.pending!.operations.compose),
    );
}

/** A controller observing a newer saved head settles the goal rather than
 * repeating the same acceptance-page request after every watchdog wake. */
export async function resumeFinishIO(...args: Parameters<typeof resumeFinishIOOnce>) {
  try {
    return await resumeFinishIOOnce(...args);
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'LANDING_SUPERSEDED') throw error;
    const [ctx, input] = args;
    await failFinish(ctx, input, error.code, error.message);
    const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    if (queue?.lease?.submissionId === input.submissionId) await releaseLandingQueue(ctx, queue);
  }
}
