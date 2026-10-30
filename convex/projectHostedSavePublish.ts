// SPDX-License-Identifier: Apache-2.0
import { wakeLifecycleSave } from './projectHostedLifecycleCascade';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  loadSave,
  saveLane,
  sameSaveLane,
  saveObjects,
  writeSaveState,
  type SaveIdentity,
} from './projectHostedSaveStore';
import { finishHostedOperation } from './projectHostedOperations';
import { writeHostedRecord } from './projectHostedRecords';
import { loadSourceJob } from './projectSourceJobs';
import { hostedSaveInput } from './projectHostedSaves';
import { saveResultSchema, savePin } from '../src/hosted-save';
import { workerResultSchema } from '../src/hosted-source-worker-format';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';

/** One small transaction: exact signed worker evidence, committed immutable State,
 * Lane CAS, one save record and original terminal receipt. No page/history walk. */
export async function publishHostedSave(ctx: MutationCtx, input: SaveIdentity & { result: string | null }) {
  const loaded = await loadSave(ctx, input, false),
    { row, state, operation } = loaded;
  if (operation.terminal) return operation.terminal;
  // Recheck current epoch even after external work; completed replays above remain immutable.
  await loadSave(ctx, input);
  let head = state.request.expected.head,
    size = state.baseline.object.size;
  if (state.request.pages) {
    invariant(
      state.status === 'submitted' && input.result,
      'SOURCE_JOB_INVALID',
      'Complete the original source job before publishing a save.',
    );
    const job = await loadSourceJob(ctx, input.projectId, row.jobId);
    invariant(
      job.operationId === state.jobOperationId &&
        job.control.actor === input.actor &&
        job.jobKind === 'save' &&
        job.authorityEpoch === state.request.authorityEpoch &&
        job.status === 'completed' &&
        job.output &&
        job.control.callbackDigest &&
        job.executionId,
      'SOURCE_JOB_INVALID',
      'A completed trusted source job is required.',
    );
    invariant(
      job.output.sha256 === digest(input.result) &&
        job.output.size === new TextEncoder().encode(input.result).length,
      'SOURCE_HASH_MISMATCH',
      'The manifest differs from the signed source-job output.',
    );
    const output = workerResultSchema.parse(JSON.parse(input.result)),
      plan = savePin(hostedSaveInput(state, operation.firstAttempt.at));
    invariant(
      canonicalPayload(output.input) === canonicalPayload(plan) &&
        canonicalPayload(job.input) === canonicalPayload(plan) &&
        job.inputDigest === plan.sha256,
      'SOURCE_JOB_INVALID',
      'The source result selected different original inputs.',
    );
    await saveObjects(ctx, input.projectId, [job.output, output.state]);
    head = output.state.sha256;
    size = output.state.size;
  } else invariant(state.status === 'ready', 'SOURCE_JOB_INVALID', 'Complete save preparation first.');
  const lane = await saveLane(ctx, { ...input, laneId: state.request.laneId });
  if (!sameSaveLane(lane, state.request.expected)) {
    const terminal = {
      attemptId: operation.firstAttempt.id,
      at: operation.firstAttempt.at,
      outcome: {
        status: 'failed' as const,
        error: {
          code: 'WORK_STALE',
          message: 'Hosted Lane changed; the original delta is retained for sync or a new save.',
        },
      },
    };
    await finishHostedOperation(ctx, { ...input, receipt: terminal });
    await writeSaveState(ctx, row._id, { ...state, status: 'stale' });
    await wakeLifecycleSave(ctx, input);
    return terminal;
  }
  const unchanged = head === lane.head,
    sourceVersion = lane.sourceVersion + (unchanged ? 0 : 1),
    version = lane.version + (unchanged ? 0 : 1),
    first = operation.firstAttempt;
  const authorityEpoch = state.request.authorityEpoch;
  if (!unchanged) {
    const prior = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', head))
      .unique();
    invariant(!prior || prior.size === size, 'SOURCE_HASH_MISMATCH', 'Registered State size differs.');
    if (!prior)
      await ctx.db.insert('projectHostedStates', {
        projectId: input.projectId,
        head,
        size,
        input: savePin(hostedSaveInput(state, first.at)).sha256,
        jobId: row.jobId,
        output: digest(input.result!),
      });
    await writeHostedRecord(ctx, {
      ...input,
      authorityEpoch,
      expectedVersion: lane.version,
      overlap: {
        ...(state.overlapChanges ? { changes: JSON.parse(state.overlapChanges) } : {}),
        complete: state.overlapComplete !== false,
      },
      record: { ...lane, head, sourceVersion, version, at: first.at },
    });
  }
  const result = saveResultSchema.parse({
    schema: 1,
    operationId: input.operationId,
    laneId: lane.id,
    saveId: first.ids.save!,
    head,
    version,
    sourceVersion,
    unchanged,
    at: first.at,
  });
  await writeHostedRecord(ctx, {
    ...input,
    authorityEpoch,
    expectedVersion: null,
    record: {
      kind: 'save',
      id: result.saveId,
      version: 0,
      at: first.at,
      laneId: lane.id,
      actor: input.actor,
      operationId: input.operationId,
      expectedHead: state.request.expected.head,
      expectedSourceVersion: state.request.expected.sourceVersion,
      head,
      sourceVersion,
      changes: state.request.pages ?? savePin([]),
    },
  });
  const terminal = { attemptId: first.id, at: first.at, outcome: { status: 'completed' as const, result } };
  await finishHostedOperation(ctx, { ...input, receipt: terminal });
  await writeSaveState(ctx, row._id, { ...state, status: 'completed' });
  await wakeLifecycleSave(ctx, input);
  return terminal;
}
export async function saveForJob(ctx: MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) {
  return ctx.db
    .query('projectHostedSaves')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
}
