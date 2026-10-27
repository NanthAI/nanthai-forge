// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { loadSync, hostedSyncInput, writeSyncState } from './projectHostedSyncStore';
import { finishHostedOperation } from './projectHostedOperations';
import { writeHostedRecord } from './projectHostedRecords';
import { saveObject, saveLane, sameSaveLane, type SaveIdentity } from './projectHostedSaveStore';
import { loadSourceJob } from './projectSourceJobs';
import { syncOutputSchema, syncResultSchema } from '../src/hosted-sync';
import { hostedLaneSelectionSchema } from '../src/hosted-lane';
import { savePin } from '../src/hosted-save';
import { digest } from '../src/portable-hash';
import { canonicalPayload, type HostedTerminalReceipt } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
/** Constant-size final CAS: never reads other Lane heads, source pages or Channel history. */
export async function publishHostedSync(ctx: MutationCtx, input: SaveIdentity & { result: string }) {
  const { row, state, operation } = await loadSync(ctx, input, false);
  if (operation.terminal) return operation.terminal;
  await loadSync(ctx, input);
  const job = await loadSourceJob(ctx, input.projectId, row.jobId),
    plan = savePin(hostedSyncInput(state, operation.firstAttempt.at));
  invariant(
    state.status === 'submitted' &&
      job.jobKind === 'sync' &&
      job.operationId === state.jobOperationId &&
      job.control.actor === input.actor &&
      job.authorityEpoch === state.request.authorityEpoch &&
      job.status === 'completed' &&
      job.output &&
      job.control.callbackDigest &&
      job.executionId,
    'SOURCE_JOB_INVALID',
    'A completed trusted sync job is required.',
  );
  invariant(
    job.output.sha256 === digest(input.result) &&
      job.output.size === new TextEncoder().encode(input.result).length,
    'SOURCE_HASH_MISMATCH',
    'The manifest differs from the signed sync result.',
  );
  const output = syncOutputSchema.parse(JSON.parse(input.result));
  invariant(
    canonicalPayload(output.input) === canonicalPayload(plan) &&
      canonicalPayload(job.input) === canonicalPayload(plan) &&
      job.inputDigest === plan.sha256,
    'SOURCE_JOB_INVALID',
    'The result selected different original sync inputs.',
  );
  const result = output.result,
    request = state.request;
  invariant(
    request.kind === 'revert'
      ? result.status === 'merged'
      : request.kind === 'resolution'
        ? result.status === 'conflict'
        : request.kind === 'resolve'
          ? result.status === 'resolved'
          : result.status === 'conflict' || result.status === 'merged' || result.status === 'up-to-date',
    'SOURCE_JOB_INVALID',
    'The source job returned a different sync operation.',
  );
  if (request.kind === 'resolution' && result.status === 'conflict')
    invariant(
      canonicalPayload(request.conflicts) === canonicalPayload(result.conflicts),
      'SOURCE_JOB_INVALID',
      'Original conflict root changed.',
    );
  if (request.kind === 'resolve' && result.status === 'resolved')
    invariant(
      canonicalPayload(result.resolution) ===
        canonicalPayload({ ...state.lane?.resolution, status: 'resolved' }),
      'SOURCE_JOB_INVALID',
      'Original resolution pins changed.',
    );
  await saveObject(ctx, input.projectId, job.output);
  await saveObject(ctx, input.projectId, result.state);
  if (result.status === 'conflict') await saveObject(ctx, input.projectId, result.conflicts);
  const first = operation.firstAttempt;
  const finish = async (outcome: HostedTerminalReceipt['outcome'], status: 'completed' | 'stale') => {
    const terminal = { attemptId: first.id, at: first.at, outcome };
    await finishHostedOperation(ctx, { ...input, receipt: terminal });
    await writeSyncState(ctx, row._id, { ...state, status });
    return terminal;
  };
  let lane = state.lane;
  if (request.kind !== 'resolution' && request.kind !== 'revert') {
    lane = await saveLane(ctx, { ...input, laneId: request.laneId });
    if (!sameSaveLane(lane, request.expected))
      return finish(
        {
          status: 'failed',
          error: {
            code: 'WORK_STALE',
            message: 'The Lane changed during sync; its newer source and original attempt are retained.',
          },
        },
        'stale',
      );
  }
  const prior = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', result.state.sha256))
    .unique();
  invariant(
    !prior || prior.size === result.state.size,
    'SOURCE_HASH_MISMATCH',
    'Registered State size differs.',
  );
  if (!prior)
    await ctx.db.insert('projectHostedStates', {
      projectId: input.projectId,
      head: result.state.sha256,
      size: result.state.size,
      input: plan.sha256,
      jobId: row.jobId,
      output: job.output.sha256,
    });
  const authorityEpoch = request.authorityEpoch;
  if (result.status === 'conflict') {
    // Preserve the conflicted Lane (if any); resolution always gets an isolated sibling.
    lane = {
      kind: 'lane',
      id: state.resolutionLaneId,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      at: first.at,
      intentId: state.intentId,
      actor: input.actor,
      base: state.base,
      head: result.state.sha256,
      state: 'active',
      authorityEpoch,
      ...(state.work.mode === 'sync' && state.work.stackAfter ? { stack: state.work.stackAfter } : {}),
      resolution: {
        ...(state.work.mode === 'sync' && state.work.stackBase
          ? { mergeBase: state.work.stackBase.object.sha256 }
          : {}),
        candidateId: request.kind === 'resolution' ? request.candidateId : null,
        conflicts: result.conflicts,
        left: result.left,
        right: result.right,
        draftHead: result.state.sha256,
        status: 'pending',
      },
    };
    await writeHostedRecord(ctx, { ...input, authorityEpoch, expectedVersion: null, record: lane });
  } else if (state.work.mode === 'revert') {
    lane = {
      kind: 'lane',
      id: state.resolutionLaneId,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      at: first.at,
      intentId: state.intentId,
      actor: input.actor,
      base: state.base,
      head: result.state.sha256,
      state: 'active',
      authorityEpoch,
      revert: {
        receiptId: state.work.receiptId,
        previous: state.work.previous.object.sha256,
        accepted: state.work.accepted.object.sha256,
      },
    };
    await writeHostedRecord(ctx, { ...input, authorityEpoch, expectedVersion: null, record: lane });
  } else {
    invariant(lane, 'SOURCE_JOB_INVALID', 'A sync needs its original Lane.');
    const changed = lane.head !== result.state.sha256;
    const stack = state.work.mode === 'sync' ? state.work.stackAfter : undefined;
    if (changed || (stack && canonicalPayload(stack) !== canonicalPayload(lane.stack))) {
      lane = {
        ...lane,
        ...(stack ? { stack } : {}),
        head: result.state.sha256,
        version: lane.version + 1,
        sourceVersion: lane.sourceVersion + 1,
        at: first.at,
        ...(result.status === 'resolved' ? { resolution: result.resolution } : {}),
      };
      await writeHostedRecord(ctx, {
        ...input,
        authorityEpoch,
        expectedVersion: lane.version - 1,
        record: lane,
      });
    }
  }
  invariant(lane, 'SOURCE_JOB_INVALID', 'Retain the resulting Lane.');
  const selection = hostedLaneSelectionSchema.parse({
    schema: 2,
    projectId: input.projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    head: lane.head,
    version: lane.version,
    sourceVersion: lane.sourceVersion,
    lifecycleVersion: lane.lifecycleVersion,
    state: lane.state,
    ...(lane.stack ? { stack: lane.stack } : {}),
    base: lane.base,
    authority: sourceAuthority((await ctx.db.get(input.projectId))!),
  });
  return finish(
    {
      status: 'completed',
      result: syncResultSchema.parse({
        schema: 1,
        operationId: input.operationId,
        status: result.status,
        lane: selection,
        from: state.lane
          ? {
              laneId: state.lane.id,
              head: state.lane.head,
              version: state.lane.version,
              sourceVersion: state.lane.sourceVersion,
            }
          : null,
        resolution: lane.resolution ?? null,
        at: first.at,
      }),
    },
    'completed',
  );
}
