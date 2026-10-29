import { semanticPayload } from '../src/semantic-payload';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { loadCompose, hostedComposeInput, writeComposeState } from './projectHostedComposeStore';
import { finishHostedOperation } from './projectHostedOperations';
import { writeHostedRecord } from './projectHostedRecords';
import { saveObjects, type SaveIdentity } from './projectHostedSaveStore';
import { loadSourceJob } from './projectSourceJobs';
import { composeResultSchema } from '../src/hosted-compose';
import { savePin } from '../src/hosted-save';
import { digest } from '../src/portable-hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** Constant-size publication. Selection/edge checks were paged before dispatch;
 * ancestry and bytes are verified by the fixed worker, never client display facts. */
export async function publishHostedCompose(ctx: MutationCtx, input: SaveIdentity & { result: string }) {
  const { row, state, operation } = await loadCompose(ctx, input, false);
  if (operation.terminal) return operation.terminal;
  await loadCompose(ctx, input);
  const job = await loadSourceJob(ctx, input.projectId, row.jobId),
    plan = savePin(hostedComposeInput(state, operation.firstAttempt.at));
  invariant(
    state.status === 'submitted' &&
      job.operationId === state.jobOperationId &&
      job.control.actor === input.actor &&
      job.jobKind === 'compose' &&
      job.authorityEpoch === state.request.authorityEpoch &&
      job.status === 'completed' &&
      job.output &&
      job.control.callbackDigest &&
      job.executionId,
    'SOURCE_JOB_INVALID',
    'A completed trusted compose job is required.',
  );
  invariant(
    job.output.sha256 === digest(input.result) &&
      job.output.size === new TextEncoder().encode(input.result).length,
    'SOURCE_HASH_MISMATCH',
    'The manifest differs from the signed compose result.',
  );
  const output = composeResultSchema.parse(JSON.parse(input.result));
  invariant(
    canonicalPayload(output.input) === canonicalPayload(plan) &&
      canonicalPayload(job.input) === canonicalPayload(plan) &&
      job.inputDigest === plan.sha256,
    'SOURCE_JOB_INVALID',
    'The result selected different original compose inputs.',
  );
  const result = output.result;
  await saveObjects(ctx, input.projectId, [
    job.output,
    result.status === 'clean' ? result.state : result.conflicts,
  ]);
  if (result.status === 'clean') {
    const prior = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q =>
        q.eq('projectId', input.projectId).eq('head', result.state.sha256),
      )
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
        jobId: job.id,
        output: job.output.sha256,
      });
  }
  const candidate = {
    kind: 'candidate' as const,
    ...(result.status === 'clean' && result.paths
      ? { governance: { version: 1 as const, paths: result.paths, ownerInputs: state.ownerInputs === true } }
      : {}),
    ...(state.semanticPlan ? { semanticPlan: state.semanticPlan } : {}),
    id: state.candidateId,
    version: 0,
    at: operation.firstAttempt.at,
    intentId: state.request.intentId,
    base: state.request.expectedMain,
    inputs: state.request.inputs.root,
    dependencies: state.request.dependencies.root,
    algorithm: `${output.algorithm}@${job.control.runtime}`,
    result: result.status === 'clean' ? { status: 'clean' as const, head: result.state.sha256 } : result,
  };
  await writeHostedRecord(ctx, {
    ...input,
    authorityEpoch: state.request.authorityEpoch,
    expectedVersion: null,
    ...(state.restoreBases ? { restoreBases: canonicalPayload(state.restoreBases) } : {}),
    record: candidate,
  });
  const terminal = {
    attemptId: operation.firstAttempt.id,
    at: operation.firstAttempt.at,
    outcome: { status: 'completed' as const, result: candidate },
  };
  await finishHostedOperation(ctx, { ...input, receipt: terminal });
  await writeComposeState(ctx, row._id, {
    ...state,
    ...(output.dropped ? { dropped: output.dropped } : {}),
    status: 'completed',
  });
  return JSON.parse(semanticPayload(terminal)) as typeof terminal;
}
