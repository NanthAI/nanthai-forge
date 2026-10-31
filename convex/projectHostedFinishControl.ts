import { loadBatch, writeBatch, wakeBatch } from './projectHostedLandingBatchStore';
import { batchFinishStep, resumeBatchIO } from './projectHostedLandingBatchFinish';
import { publishLandingBatch } from './projectHostedLandingBatchPublish';
// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import { loadFinish, failFinish } from './projectHostedFinishStore';
import { loadLanding, writeLanding, type LandingIdentity } from './projectHostedLandingStore';
import { scheduleFinish, watchFinishCompose } from './projectHostedFinishWake';
import { prepareFinishCompose, installFinishCompose, reserveFinishRetry } from './projectHostedFinishCompose';
import { hostedComposeInput } from './projectHostedComposeStore';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { prepareAcceptance, stageAcceptance } from './projectHostedAcceptanceStore';
import { releaseLandingQueue } from './projectHostedLandingWake';
import { landingQueue } from './projectHostedLandingStore';
import { claimReadyLanding } from './projectHostedLandingControl';
import { publishAcceptance } from './projectHostedAcceptancePublish';
import { hostedWriteProject } from './projectHostedRecords';
import { blobStore } from './blobStore';
import { presignGet, r2Config, r2Key } from './r2';
import { isStored } from './projectObjectFields';
import { canonicalPayload } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { landingObservation } from '../src/hosted-landing';
import type { FinishCommand } from '../src/hosted-finish';
import { ForgeError, invariant } from '../src/errors';
import { reuseContext } from './projectHostedReuseStore';
import { findObject, objectRow } from './projectObjectFind';
export type FinishIdentity = LandingIdentity & { wakeId: string };
export async function finishStep(ctx: MutationCtx, input: FinishIdentity): Promise<FinishCommand | null> {
  const { row, value } = await loadFinish(ctx, input);
  if (row.wake?.id !== input.wakeId || row.wake.at > Date.now()) return null;
  // A completed/lost reply never permits an older IO callback to advance later work.
  await ctx.db.patch(row._id, { wake: null });
  const { row: landing, state } = await loadLanding(ctx, input);
  try {
    const batchStep = await batchFinishStep(ctx, input, row);
    if (batchStep.handled) return batchStep.command;
    if (state.phase === 'landed' || state.phase === 'terminal-failed') return null;
    await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
    if (value.recoveryRunId) {
      const audit = await ctx.db
        .query('projectHostedMainAudits')
        .withIndex('by_project', q => q.eq('projectId', input.projectId))
        .unique();
      if (audit?.red?.runId !== value.recoveryRunId) {
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
        else if (state.observation.pendingReason !== 'waiting-for-dependency')
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
            await scheduleFinish(ctx, row, row.reuseLease.until - Date.now(), true);
          } else {
            // Unknown proof outcome: one ordinary exact check, never a second
            // simultaneous analysis. Late callbacks are fenced by pending ID.
            await installFinishCompose(ctx, row, value);
          }
          return null;
        }
        if (await reuseContext(ctx, input)) {
          await scheduleFinish(ctx, row, 30_000, true);
          return { kind: 'reuse', pendingId: value.pending.id };
        }
        await installFinishCompose(ctx, row, value);
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
        await watchFinishCompose(ctx, row._id, value.pending.at);
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
        await watchFinishCompose(ctx, row._id, value.pending.at);
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
        await ctx.db.patch((await objectRow(ctx, object))._id, { location: 'r2', r2Key: key });
      }
      await scheduleFinish(ctx, row, 30_000, true);
      return { kind: 'plan', value: plan, pin };
    }
    if (state.phase !== 'ready') return null; // H13's run/queue events resume it
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
          ? await presignGet(r2Config(), object.r2Key)
          : object.storageId
            ? await blobStore(ctx).getUrl(object.storageId)
            : null;
      invariant(url, 'SOURCE_UNAVAILABLE', 'Exact acceptance metadata is unavailable.');
      await scheduleFinish(ctx, row, 30_000, true);
      return {
        kind: 'page',
        url,
        pin,
        selection: {
          attemptId: state.attemptId,
          kind,
          index: kind === 'inputs' ? plan.inputPages : plan.dependencyPages,
        },
      };
    }
    const claim = await claimReadyLanding(ctx, { ...selection, channel: 'main', owner: plan.receiptId });
    if (!claim) {
      await scheduleFinish(ctx, (await ctx.db.get(row._id))!, 250);
      return null;
    }
    try {
      if (state.batchId && !state.batchSolo) await publishLandingBatch(ctx, claim);
      else await publishAcceptance(ctx, claim);
    } catch (error) {
      if (error instanceof ForgeError && ['CHANNEL_CHANGED', 'CHECK_EVIDENCE_REFRESH'].includes(error.code)) {
        // Yield the Channel so later independent runnable requests can advance.
        const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
        if (queue) await releaseLandingQueue(ctx, queue);
        await reserveFinishRetry(ctx, (await ctx.db.get(row._id))!, value);
      } else throw error;
    }
    return null;
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    if (state.batchId && !state.batchSolo) {
      const key = { projectId: input.projectId, batchId: state.batchId };
      const { batch } = await loadBatch(ctx, key);
      if (batch.phase === 'composing' || batch.phase === 'checking') {
        await writeBatch(ctx, key, { ...batch, phase: 'fallback' });
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
  const { state } = await loadLanding(ctx, input);
  if (input.command.kind === 'plan' && input.command.batchId) {
    await resumeBatchIO(ctx, { ...input, command: input.command });
    return;
  }
  if (state.phase === 'landed' || state.phase === 'terminal-failed') return;
  await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
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
      await ctx.db.patch((await objectRow(ctx, old))._id, { r2Committed: true });
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
      else if (!isStored(old)) await ctx.db.patch((await objectRow(ctx, old))._id, { storageId });
    }
    await submitHostedCompose(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      operationId: value.pending.operations.compose,
    });
  }
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  await ctx.db.patch(row._id, { wake: null });
  if (input.command.kind === 'page') await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
  else await watchFinishCompose(ctx, row._id, value.pending!.at);
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
