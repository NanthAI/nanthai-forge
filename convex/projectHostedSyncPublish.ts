// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';
import { syncForJob } from './projectHostedSyncStore';
import type { MutationCtx } from './_generated/server';
import { loadSync, hostedSyncInput, writeSyncState } from './projectHostedSyncStore';
import { finishHostedOperation } from './projectHostedOperations';
import { writeHostedRecord } from './projectHostedRecords';
import { supersedeSyncRequired } from './projectHostedLaneFinish';
import { markRestackConflict } from './projectHostedStackNotice';
import { saveObjects, saveLaneRecord, sameSaveLane, type SaveIdentity } from './projectHostedSaveStore';
import { loadSourceJob } from './projectSourceJobs';
import { sourceServerTiming } from './projectSourceStepTiming';
import { syncOutputSchema, syncResultSchema } from '../src/hosted-sync';
import { syncDocsUndo } from '../src/docs-resolution';
import { savePin } from '../src/hosted-save';
import { digest } from '../src/portable-hash';
import { canonicalPayload, type HostedTerminalReceipt } from '../src/hosted-source-operation';
import { syncLaneSelection } from './projectHostedSyncUpToDate';
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
  await saveObjects(ctx, input.projectId, [
    job.output,
    result.state,
    ...(result.status === 'conflict' ? [result.conflicts] : []),
  ]);
  const first = operation.firstAttempt;
  const finish = async (outcome: HostedTerminalReceipt['outcome'], status: 'completed' | 'stale') => {
    const terminal = { attemptId: first.id, at: first.at, outcome };
    await finishHostedOperation(ctx, { ...input, receipt: terminal });
    // The receipt's server split: one indexed read of the execution's step row (friction 84c1497f).
    const serverTiming = await sourceServerTiming(ctx, input.projectId, row.jobId);
    await writeSyncState(ctx, row._id, { ...state, status, ...(serverTiming ? { serverTiming } : {}) });
    return terminal;
  };
  // Old sync state could derive true from its target alone, omitting a mixed left side.
  const ownerInputs = state.ownerProvenance === 1 && state.ownerInputs === true;
  let lane = state.lane;
  let clearOwnerProvenance = false;
  if (request.kind !== 'resolution' && request.kind !== 'revert') {
    const original = await saveLaneRecord(ctx, { ...input, laneId: request.laneId });
    lane = original.lane;
    clearOwnerProvenance = original.ownerOnly && !ownerInputs;
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
  if (result.status === 'conflict' && request.kind === 'sync' && request.cleanOnly) {
    // An automatic restack that would conflict changes nothing: the Lane keeps its head and stack, no
    // resolution Lane is made, and the parent head is marked so later saves do not retry it.
    invariant(
      lane && state.work.mode === 'sync' && state.work.stackAfter,
      'SOURCE_JOB_INVALID',
      'A restack needs its stacked Lane.',
    );
    await markRestackConflict(ctx, input.projectId, lane.id, state.work.stackAfter.head);
  } else if (result.status === 'conflict') {
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
        ...(state.origin ? { origin: state.origin } : {}),
        status: 'pending',
      },
    };
    await writeHostedRecord(ctx, {
      ...input,
      authorityEpoch,
      expectedVersion: null,
      ownerOnly: ownerInputs,
      record: lane,
    });
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
    // A Lane that took main in (merged or already up to date; a conflict took a draft Lane above) is now based on that main: behindMain, diffs and
    // overlap windows then count only what main did since, never the already merged commits (4f167dfd, 89166743).
    // A stacked Lane merged its parent, not main, and a Candidate sync targets no main: both keep their base.
    const rebase =
      request.kind === 'sync' &&
      request.target.kind === 'main' &&
      (!stack || stack.detached) &&
      (lane.base.head !== request.target.head || lane.base.receiptId !== request.target.receiptId)
        ? { head: request.target.head, receiptId: request.target.receiptId }
        : null;
    // One indexed read gives the new base its main sequence, so behindMain counts from it at once.
    const rebaseRow = rebase
      ? await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_receipt', q =>
            q.eq('projectId', input.projectId).eq('receiptId', rebase.receiptId),
          )
          .unique()
      : null;
    if (
      changed ||
      rebase ||
      clearOwnerProvenance ||
      result.status === 'resolved' ||
      (stack && canonicalPayload(stack) !== canonicalPayload(lane.stack))
    ) {
      lane = {
        ...lane,
        ...(stack ? { stack } : {}),
        ...(rebase ? { base: rebase } : {}),
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
        ownerOnly: ownerInputs,
        // The Lane's own saved paths stay as evidence (an over-approximation against the newer base, never a miss).
        ...(rebase
          ? { overlap: { rebased: true, ...(rebaseRow ? { baseSequence: rebaseRow.sequence } : {}) } }
          : {}),
        record: lane,
      });
      // A sync that moved the head replaces the Lane's queued entries that needed it (f7539ebb).
      if (changed)
        await supersedeSyncRequired(ctx, { projectId: input.projectId, laneId: lane.id, head: lane.head });
    }
  }
  invariant(lane, 'SOURCE_JOB_INVALID', 'Retain the resulting Lane.');
  const selection = await syncLaneSelection(ctx, input.projectId, lane);
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
        ...(result.status === 'merged' && result.docs && state.lane
          ? { docsResolution: { ...result.docs, undo: syncDocsUndo(state.lane.head) } }
          : {}),
        at: first.at,
      }),
    },
    'completed',
  );
}
/** The publish transaction for this job: the scheduled `publish`, or a step's terminal commit. */
export async function publishSyncJob(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; jobId: string; result: string },
) {
  const row = await syncForJob(ctx, input.projectId, input.jobId);
  if (!row) return null;
  if (row.culpritRunId)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:advance'), {
      projectId: row.projectId,
      runId: row.culpritRunId,
    });
  return canonicalPayload(
    await publishHostedSync(ctx, {
      projectId: input.projectId,
      operationId: row.operationId,
      actor: row.actor,
      result: input.result,
    }),
  );
}
