// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import type { z } from 'zod';
import type { Id } from './_generated/dataModel';
import { composeForJob } from './projectHostedComposeStore';
import { semanticPayload } from '../src/semantic-payload';
import type { MutationCtx } from './_generated/server';
import { loadCompose, hostedComposeInput, writeComposeState } from './projectHostedComposeStore';
import { finishHostedOperation } from './projectHostedOperations';
import { writeHostedRecord } from './projectHostedRecords';
import { saveObjects, type SaveIdentity } from './projectHostedSaveStore';
import { loadSourceJob } from './projectSourceJobs';
import type { SourcePhaseTiming } from '../src/hosted-source-retry';
import { sourceR2Counts, sourceServerTiming, type sourceServerTimingSchema } from './projectSourceStepTiming';
import { composeResultSchema } from '../src/hosted-compose';
import { savePin } from '../src/hosted-save';
import { digest } from '../src/state/hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedRecord } from '../src/hosted-records';
import { invariant } from '../src/errors';
/** Constant-size publication. Selection/edge checks were paged before dispatch;
 * ancestry and bytes are verified by the fixed worker, never client display facts. */
export async function publishHostedCompose(
  ctx: MutationCtx,
  input: SaveIdentity & {
    result: string;
    /** R2 requests the job's steps signed, when the committing step already holds its step row. */
    source?: {
      r2: [number, number, number];
      timing?: SourcePhaseTiming;
      serverTiming?: z.infer<typeof sourceServerTimingSchema>;
    };
  },
) {
  const { row, state, operation, project } = await loadCompose(ctx, input, false);
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
    ...(result.status === 'clean' && result.candidateFiles ? [result.candidateFiles] : []),
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
  const publicResult: Extract<HostedRecord, { kind: 'candidate' }>['result'] =
    result.status === 'clean'
      ? { status: 'clean', head: result.state.sha256 }
      : { status: 'conflict', conflicts: result.conflicts };
  // Pre-upgrade batch state could omit speculative-prefix provenance.
  const ownerInputs =
    state.ownerProvenance === 1 && state.ownerInputs === true && input.actor === project.owner;
  const candidate = {
    kind: 'candidate' as const,
    ...(state.earlyResolutions?.length
      ? {
          earlyResolutions: [
            ...new Map(state.earlyResolutions.map(early => [early.predecessor.receiptId, early])).values(),
          ],
        }
      : {}),
    ...(result.status === 'clean' && result.paths
      ? { governance: { version: 1 as const, paths: result.paths, ownerInputs } }
      : {}),
    ...(state.semanticPlan ? { semanticPlan: state.semanticPlan } : {}),
    ...(result.status === 'clean' && result.docs ? { docs: result.docs } : {}),
    id: state.candidateId,
    version: 0,
    at: operation.firstAttempt.at,
    intentId: state.request.intentId,
    base: state.request.expectedMain,
    inputs: state.request.inputs.root,
    dependencies: state.request.dependencies.root,
    algorithm: `${output.algorithm}@${job.control.runtime}`,
    result: publicResult,
  };
  await writeHostedRecord(ctx, {
    ...input,
    authorityEpoch: state.request.authorityEpoch,
    expectedVersion: null,
    ownerOnly: ownerInputs,
    ...(state.restoreBases ? { restoreBases: canonicalPayload(state.restoreBases) } : {}),
    ...(result.status === 'clean' && result.candidateFiles ? { candidateFiles: result.candidateFiles } : {}),
    record: candidate,
  });
  const terminal = {
    attemptId: operation.firstAttempt.id,
    at: operation.firstAttempt.at,
    outcome: { status: 'completed' as const, result: candidate },
  };
  await finishHostedOperation(ctx, { ...input, receipt: terminal });
  // The terminal commit hands its step row's sum in; the scheduled publish reads that row once.
  const timing = input.source ? undefined : await sourceServerTiming(ctx, input.projectId, row.jobId);
  const r2 = input.source?.r2 ?? sourceR2Counts(timing);
  const sourceTiming = input.source?.timing ?? timing?.summary;
  // Stored compactly: the summary and R2 counts already sit in this state as `sourceTiming` and `r2`.
  const full = input.source?.serverTiming ?? timing;
  const serverTiming = full && {
    queuedAt: full.queuedAt,
    scheduledAt: full.scheduledAt,
    ...(full.doneAt === undefined ? {} : { doneAt: full.doneAt }),
    publishedAt: full.publishedAt,
    steps: full.steps.map(step =>
      Object.fromEntries(
        ['phase', 'stop', 'bootMs', 'runMs', 'reads', 'writes'].flatMap(key =>
          step[key] === undefined ? [] : [[key, step[key]]],
        ),
      ),
    ),
  };
  await writeComposeState(ctx, row._id, {
    ...state,
    ...(r2.some(Boolean) ? { r2 } : {}),
    ...(sourceTiming ? { sourceTiming } : {}),
    ...(serverTiming ? { serverTiming } : {}),
    ...(output.dropped ? { dropped: output.dropped } : {}),
    ...(result.status === 'conflict' && result.paths
      ? { conflictSummary: { paths: result.paths, more: result.more ?? 0 } }
      : {}),
    status: 'completed',
  });
  return JSON.parse(semanticPayload(terminal)) as typeof terminal;
}
/** The publish transaction for this job: the scheduled `publish`, or a step's terminal commit. */
export async function publishComposeJob(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    result: string;
    source?: {
      r2: [number, number, number];
      timing?: SourcePhaseTiming;
      serverTiming?: z.infer<typeof sourceServerTimingSchema>;
    };
  },
) {
  const row = await composeForJob(ctx, input.projectId, input.jobId);
  if (!row) return null;
  if (row.culpritRunId)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:advance'), {
      projectId: row.projectId,
      runId: row.culpritRunId,
    });
  return canonicalPayload(
    await publishHostedCompose(ctx, {
      projectId: input.projectId,
      operationId: row.operationId,
      actor: row.actor,
      result: input.result,
      ...(input.source ? { source: input.source } : {}),
    }),
  );
}
