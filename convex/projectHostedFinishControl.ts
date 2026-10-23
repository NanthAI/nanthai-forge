// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { loadFinish, failFinish } from './projectHostedFinishStore';
import { loadLanding, writeLanding, type LandingIdentity } from './projectHostedLandingStore';
import { scheduleFinish } from './projectHostedFinishWake';
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
import { presignGet, r2Config } from './r2';
import { isStored } from './projectObjectFields';
import { canonicalPayload } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { landingObservation } from '../src/hosted-landing';
import type { FinishCommand } from '../src/hosted-finish';
import { ForgeError, invariant } from '../src/errors';
export type FinishIdentity = LandingIdentity & { wakeId: string };
export async function finishStep(ctx: MutationCtx, input: FinishIdentity): Promise<FinishCommand | null> {
  const { row, value } = await loadFinish(ctx, input);
  if (row.wake?.id !== input.wakeId || row.wake.at > Date.now()) return null;
  // A completed/lost reply never permits an older IO callback to advance later work.
  await ctx.db.patch(row._id, { wake: null });
  const { row: landing, state } = await loadLanding(ctx, input);
  if (state.phase === 'landed' || state.phase === 'terminal-failed') return null;
  try {
    await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
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
        return null;
      }
      const plan = canonicalPayload(hostedComposeInput(source.state, source.operation.firstAttempt.at));
      const pin = savePin(JSON.parse(plan));
      const object = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
        .unique();
      if (object && !object.removed && object.size === pin.size && isStored(object)) {
        await submitHostedCompose(ctx, {
          projectId: input.projectId,
          actor: state.actor,
          operationId: value.pending.operations.compose,
        });
        return null;
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
      const object = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
        .unique();
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
      await publishAcceptance(ctx, claim);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'CHANNEL_CHANGED') {
        // Yield the Channel so later independent runnable requests can advance.
        const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
        if (queue) await releaseLandingQueue(ctx, queue);
        await reserveFinishRetry(ctx, (await ctx.db.get(row._id))!, value);
      } else throw error;
    }
    return null;
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    await failFinish(ctx, input, error.code, error.message);
    const queue = await landingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    if (queue?.lease?.submissionId === input.submissionId) await releaseLandingQueue(ctx, queue);
    return null;
  }
}
/** One exact IO completion; duplicate or delayed generations do nothing. */
export async function resumeFinishIO(
  ctx: MutationCtx,
  input: FinishIdentity & { command: FinishCommand; page?: unknown; storageId?: string },
) {
  const { row, value } = await loadFinish(ctx, input);
  if (row.wake?.id !== input.wakeId) return;
  const { state } = await loadLanding(ctx, input);
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
    invariant(value.pending && input.storageId, 'WORK_STALE', 'Resume only the pending composition.');
    const source = await prepareFinishCompose(ctx, input, value);
    const plan = hostedComposeInput(source.state, source.operation.firstAttempt.at),
      pin = savePin(plan);
    invariant(
      canonicalPayload(pin) === canonicalPayload(input.command.pin) &&
        canonicalPayload(plan) === input.command.value,
      'WORK_OPERATION_CHANGED',
      'Upload only the original pending source plan.',
    );
    const metadata = await blobStore(ctx).getMetadata(input.storageId);
    invariant(
      metadata?.sha256 === pin.sha256 && metadata.size === pin.size,
      'SOURCE_HASH_MISMATCH',
      'Uploaded source plan differs from its exact bytes.',
    );
    const old = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
      .unique();
    invariant(
      !old || (!old.removed && old.size === pin.size),
      'SOURCE_HASH_MISMATCH',
      'Source plan binding differs.',
    );
    if (!old)
      await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: pin.sha256,
        size: pin.size,
        storageId: input.storageId as import('./_generated/dataModel').Id<'_storage'>,
        nonce: crypto.randomUUID(),
        removed: false,
      });
    if (old && !isStored(old))
      await ctx.db.patch(old._id, {
        storageId: input.storageId as import('./_generated/dataModel').Id<'_storage'>,
      });
    await submitHostedCompose(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      operationId: value.pending.operations.compose,
    });
  }
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  await ctx.db.patch(row._id, { wake: null });
  if (input.command.kind === 'page') await scheduleFinish(ctx, (await ctx.db.get(row._id))!);
}
