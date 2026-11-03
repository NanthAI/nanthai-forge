import { exhaustFinishCompose } from './projectHostedComposeExhaustion';
import { predecessorStatus } from './projectHostedLandingPipeline';
import { settleBatchConflicts, retainSurvivorTrain } from './projectHostedLandingCohortConflicts';
import { deferSpeculativeConflict } from './projectHostedLandingSpeculativeConflict';
import { wakeLandingQueue } from './projectHostedLandingEvents';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { splitLandingBatch } from './projectHostedLandingBatchSplit';
// SPDX-License-Identifier: Apache-2.0
import { releaseUnstartedBatchForPriority } from './projectHostedLandingBatchPriority';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { FinishIdentity } from './projectHostedFinishControl';
import { settleMemberBatchConflict } from './projectHostedLandingBatchConflict';
import { batchConflictPeers } from './projectHostedLandingConflictPeers';
import { failFinish, loadFinish } from './projectHostedFinishStore';
import { loadLanding } from './projectHostedLandingStore';
import {
  loadBatch,
  writeBatch,
  wakeBatch,
  enqueueBatchCheck,
  installBatchAttempt,
  retryLandingBatch,
} from './projectHostedLandingBatchStore';
import { prepareBatchCompose } from './projectHostedLandingBatchCompose';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { FinishCommand } from '../src/hosted-finish';
import { r2Key } from './r2';
import { scheduleFinish, watchFinishCompose } from './projectHostedFinishWake';
import { isStored } from './projectObjectFields';
import { hostedStartMain } from './projectHostedChannels';
import { invariant } from '../src/errors';
import { findObject, objectRow } from './projectObjectFind';

export async function batchFinishStep(
  ctx: MutationCtx,
  input: FinishIdentity,
  originalRow: Doc<'projectHostedFinishes'>,
): Promise<{
  handled: boolean;
  command: FinishCommand | null;
}> {
  const { state } = await loadLanding(ctx, input);
  const batchId = state.batchId ?? state.batchOriginId;
  if (!batchId) return { handled: false, command: null };
  const key = { projectId: input.projectId, batchId };
  const { batch } = await loadBatch(ctx, key);
  if (batch.phase === 'superseded') return { handled: true, command: null };
  if (
    state.batchId === batch.id &&
    batch.included &&
    state.phase === 'queued' &&
    !batch.included.includes(state.id)
  ) {
    await settleBatchConflicts(ctx, key, batch);
    return { handled: true, command: null };
  }
  if (await releaseUnstartedBatchForPriority(ctx, key, batch)) return { handled: true, command: null };
  if (
    state.phase === 'queued' &&
    state.observation.stall &&
    (batch.phase === 'composing' || batch.phase === 'checking')
  ) {
    // A pre-upgrade alarm may already be consumed. Resume/event repair must
    // reselect the member too, without needing another timer or a backfill.
    // A cohort that cannot compose (2026-10-30: a merge step failed on every
    // retry) splits into parallel halves; no test failed, so nobody waits in
    // a serial single-check line.
    if (batch.phase === 'composing') {
      await splitLandingBatch(ctx, key, batch);
      return { handled: true, command: null };
    }
    const fallback = {
      ...batch,
      phase: 'fallback' as const,
      transition: { code: 'LANDING_STALLED', message: 'The shared check stopped making progress.' },
    };
    await writeBatch(ctx, key, fallback);
    return advanceBatchFallback(ctx, key, fallback, state.id);
  }
  if (batch.phase === 'landed' && state.batchId && !['landed', 'terminal-failed'].includes(state.phase)) {
    const fallback = {
      ...batch,
      phase: 'fallback' as const,
      transition: {
        code: 'BATCH_MEMBER_ORPHANED',
        message: 'A nonterminal member outlived its settled cohort; restore its individual preparation.',
      },
    };
    await writeBatch(ctx, key, fallback);
    return advanceBatchFallback(ctx, key, fallback, state.id);
  }
  if (batch.phase === 'fallback') {
    if (state.batchId) await writeBatch(ctx, key, batch);
    return advanceBatchFallback(ctx, key, batch, state.id);
  }
  if (state.batchOriginId) return { handled: false, command: null };
  if (state.batchSolo || state.phase === 'ready' || state.phase === 'landed')
    return { handled: false, command: null };
  if (state.id !== (batch.leaderId ?? batch.id) || batch.phase !== 'composing')
    return { handled: true, command: null };
  const source = await prepareBatchCompose(ctx, key);
  if (source.operation.terminal) {
    const outcome = source.operation.terminal.outcome;
    if (outcome.status === 'failed') {
      if (outcome.error.code === 'SOURCE_RETRY_EXHAUSTED') {
        for (const member of batch.members)
          await failFinish(
            ctx,
            { projectId: input.projectId, submissionId: member.submissionId },
            outcome.error.code,
            outcome.error.message,
          );
        await writeBatch(ctx, key, { ...batch, phase: 'failed', included: [], transition: outcome.error });
        await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
        return { handled: true, command: null };
      }
      await splitLandingBatch(ctx, key, batch, undefined, outcome.error);
      return { handled: true, command: null };
    }
    const candidate = hostedRecordSchema.options[3].parse(outcome.result);
    invariant(
      candidate.id === source.state.candidateId &&
        candidate.result.status === 'clean' &&
        canonicalPayload(candidate.base) === canonicalPayload(source.state.request.expectedMain),
      'COMPOSITION_CONFLICT',
      'Batch worker must retain member conflicts.',
    );
    const dropped = source.state.dropped ?? [];
    const main = await hostedStartMain(ctx, input.projectId);
    const predecessor = await predecessorStatus(ctx, key, batch);
    // A rejected speculative prefix is not main. Never retain a terminal
    // conflict before checking its generation, including an all-dropped group.
    if (
      predecessor === 'invalid' ||
      (predecessor !== 'pending' &&
        (main.head !== source.state.request.expectedMain.head ||
          main.receipt.id !== source.state.request.expectedMain.receiptId))
    ) {
      await retryLandingBatch(ctx, key, batch);
      return { handled: true, command: null };
    }
    const included = batch.members.filter(m => !dropped.some(d => d.candidateId === m.candidate.id));
    for (const member of batch.members) {
      const current = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: member.submissionId,
      });
      if (current.state.phase === 'terminal-failed') {
        if (!included.includes(member)) continue;
        await writeBatch(ctx, key, {
          ...batch,
          phase: 'fallback',
          transition: {
            code: 'BATCH_MEMBER_SETTLED',
            message: 'A member included in the shared Candidate settled before its evidence was installed.',
          },
        });
        await wakeBatch(ctx, key);
        return { handled: true, command: null };
      }
      if (included.includes(member))
        await hostedWriteProject(ctx, input.projectId, member.actor.id, member.authorityEpoch);
    }
    if (predecessor === 'pending' && dropped.length) await deferSpeculativeConflict(ctx, key, batch, dropped);
    for (const member of batch.members.filter(
      m => predecessor !== 'pending' && dropped.some(d => d.candidateId === m.candidate.id),
    )) {
      if (
        (await loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId })).state
          .phase === 'terminal-failed'
      )
        continue;
      const conflict = dropped.find(d => d.candidateId === member.candidate.id)!;
      await settleMemberBatchConflict(ctx, {
        projectId: input.projectId,
        member,
        main: source.state.request.expectedMain,
        conflict,
        ownerInputs: source.state.ownerProvenance === 1 && source.state.ownerInputs === true,
        peerLanes: await batchConflictPeers(
          ctx,
          input.projectId,
          batch,
          member.candidate.id,
          dropped.map(d => d.candidateId),
        ),
        at: batch.at,
      });
    }
    if (!included.length) {
      await retainSurvivorTrain(ctx, key, [], batch);
      await writeBatch(ctx, key, {
        ...batch,
        included: [],
        phase: predecessor === 'pending' ? 'composing' : 'landed',
      });
      await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
      return { handled: true, command: null };
    }
    const settings = (await loadFinish(ctx, input)).value.check;
    invariant(
      settings?.kind === 'request',
      'SOURCE_UNAVAILABLE',
      'A batch needs the original exact check settings.',
    );
    const { kind: _kind, ...check } = settings;
    void _kind;
    const run = await enqueueBatchCheck(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      request: {
        ...check,
        operationId: batch.checkOperationId,
        authorityEpoch: batch.members[0]!.authorityEpoch,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
      },
    });
    const row = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      kind: 'candidate',
      key: candidate.id,
    });
    invariant(row, 'SOURCE_UNAVAILABLE', 'The stacked Candidate is unavailable.');
    for (const member of included)
      await installBatchAttempt(ctx, {
        projectId: input.projectId,
        original: member,
        main: source.state.request.expectedMain,
        checkOperationId: run.request.operationId,
        candidate: {
          id: candidate.id,
          digest: row.digest,
          head: candidate.result.head,
          inputs: candidate.inputs,
          dependencies: candidate.dependencies,
          algorithm: candidate.algorithm,
        },
        check: {
          runId: run.id,
          checkId: run.check.id,
          definition: run.check.definition,
          configuration: run.request.expectedConfiguration,
          environment: run.request.expectedEnvironment,
        },
      });
    await writeBatch(ctx, key, {
      ...batch,
      phase: 'checking',
      runId: run.id,
      included: included.map(m => m.submissionId),
    });
    await retainSurvivorTrain(
      ctx,
      key,
      included.map(member => member.submissionId),
      batch,
    );
    await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
    return { handled: true, command: null };
  }
  const upload = source.uploads[batch.uploadIndex];
  if (upload) {
    const object = await findObject(ctx, input.projectId, upload.pin.sha256);
    const objectKey = r2Key(input.projectId, upload.pin.sha256);
    if (object) {
      invariant(
        !object.removed && object.size === upload.pin.size,
        'SOURCE_HASH_MISMATCH',
        'Batch metadata object differs.',
      );
      if (isStored(object)) {
        // Empty selection pages are shared with ordinary compose and may live
        // in Convex storage or a recipe. Their location is not source identity.
        await writeBatch(ctx, key, { ...batch, uploadIndex: batch.uploadIndex + 1 });
        await wakeBatch(ctx, key);
        return { handled: true, command: null };
      }
      await ctx.db.patch((await objectRow(ctx, object))._id, { location: 'r2', r2Key: objectKey });
    } else
      await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: upload.pin.sha256,
        size: upload.pin.size,
        nonce: crypto.randomUUID(),
        removed: false,
        location: 'r2',
        r2Key: objectKey,
      });
    await scheduleFinish(ctx, originalRow, 30_000, true);
    return {
      handled: true,
      command: {
        kind: 'plan',
        ...upload,
        batchId: batch.id,
        batchComposeOperationId: batch.composeOperationId,
      },
    };
  }
  await submitHostedCompose(ctx, source.auth);
  await watchFinishCompose(ctx, originalRow._id, source.operation.firstAttempt.at, async () =>
    exhaustFinishCompose(ctx, (await ctx.db.get(originalRow._id))!, source.auth.operationId),
  );
  return { handled: true, command: null };
}
export async function resumeBatchIO(
  ctx: MutationCtx,
  input: FinishIdentity & { command: Extract<FinishCommand, { kind: 'plan' }>; key?: string },
) {
  const key = { projectId: input.projectId, batchId: input.command.batchId! };
  const { batch } = await loadBatch(ctx, key);
  if (batch.phase !== 'composing' || input.command.batchComposeOperationId !== batch.composeOperationId)
    return;
  const source = await prepareBatchCompose(ctx, key),
    upload = source.uploads[batch.uploadIndex];
  invariant(
    upload &&
      canonicalPayload(upload.pin) === canonicalPayload(input.command.pin) &&
      upload.value === input.command.value &&
      input.key === r2Key(input.projectId, upload.pin.sha256),
    'WORK_OPERATION_CHANGED',
    'Resume only the retained batch metadata upload.',
  );
  const object = await findObject(ctx, input.projectId, upload.pin.sha256);
  invariant(
    object && !object.removed && object.size === upload.pin.size && object.r2Key === input.key,
    'SOURCE_HASH_MISMATCH',
    'Batch metadata reservation differs.',
  );
  await ctx.db.patch((await objectRow(ctx, object))._id, { r2Committed: true });
  await writeBatch(ctx, key, { ...batch, uploadIndex: batch.uploadIndex + 1 });
  const { row } = await loadFinish(ctx, input);
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  await ctx.db.patch(row._id, { wake: null });
  await wakeBatch(ctx, key);
}
