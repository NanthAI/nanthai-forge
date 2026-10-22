// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import {
  checkCaller,
  checkSetting,
  beginCheckOperation,
  completeCheckOperation,
  loadHostedCheck,
  writeHostedCheck,
  completeHostedCheck,
} from './projectHostedCheckStore';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedCheckRequestSchema,
  hostedCheckRunnerSchema,
  hostedCheckRunSchema,
  hostedCheckTerminal,
  checkPin,
  checkNumber,
} from '../src/hosted-check';
import { checkSchema } from '../src/work-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const enqueue = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await checkCaller(ctx, input.projectId);
      return canonicalPayload(
        await enqueueHostedCheck(ctx, {
          projectId: input.projectId,
          actor,
          request: JSON.parse(input.request),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
const cancelSchema = z
  .object({ operationId: z.uuid(), runId: z.uuid(), authorityEpoch: checkNumber })
  .strict();
export const cancel = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = cancelSchema.parse(JSON.parse(input.request));
      const { actor, project } = await checkCaller(ctx, input.projectId);
      const { row, run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: request.runId });
      invariant(
        actor === run.actor || actor === project.owner,
        'PROJECT_UNAVAILABLE',
        'Cancel a check requested by this account or project owner.',
      );
      const prepared = await beginCheckOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: request.operationId,
        expected: { authorityEpoch: request.authorityEpoch, resourceId: request.runId },
        payload: request,
      });
      if (prepared.replayed) return canonicalPayload(run);
      if (!hostedCheckTerminal(run)) {
        await hostedWriteProject(ctx, input.projectId, run.actor, run.request.authorityEpoch);
        run.cancelRequested = true;
        // Nothing external was submitted: cancellation is already certain. Once
        // dispatch is reserved, only the provider can acknowledge cancellation.
        if (!run.dispatchStarted) {
          run.status = 'cancelled';
          run.endedAt = new Date().toISOString();
          run.terminalDigest = checkPin({ kind: 'cancel-before-dispatch', request });
          await completeHostedCheck(ctx, run);
        }
        await writeHostedCheck(ctx, row._id, run);
      }
      await completeCheckOperation(ctx, prepared.operation, {
        runId: run.id,
        cancelRequested: run.cancelRequested,
      });
      return canonicalPayload(run);
    } catch (error) {
      return report(error);
    }
  },
});

/** Shared transaction seam: caller resolves actor from current authentication.
 * No provider work or scheduling runs here. */
export async function enqueueHostedCheck(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: unknown;
  },
) {
  const request = hostedCheckRequestSchema.parse(input.request);
  const actor = input.actor;
  const prepared = await beginCheckOperation(ctx, {
    projectId: input.projectId,
    actor,
    operationId: request.operationId,
    expected: {
      authorityEpoch: request.authorityEpoch,
      resourceId: request.candidateId,
      head: request.expectedHead,
    },
    payload: request,
  });
  if (prepared.replayed)
    return (
      await loadHostedCheck(ctx, {
        projectId: input.projectId,
        runId: prepared.operation.firstAttempt.ids.run!,
      })
    ).run;
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor,
    kind: 'candidate',
    key: request.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Select a canonical hosted Candidate.');
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  invariant(
    candidate.kind === 'candidate' &&
      candidate.result.status === 'clean' &&
      candidate.result.head === request.expectedHead,
    'VIEW_STALE',
    'Select this clean Candidate and its exact head.',
  );
  const registered = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q =>
      q.eq('projectId', input.projectId).eq('head', request.expectedHead),
    )
    .unique();
  invariant(registered, 'SOURCE_UNAVAILABLE', 'The Candidate needs trusted source registration.');
  const source = await saveObject(ctx, input.projectId, { sha256: request.expectedHead });
  invariant(
    source.object.size === registered.size,
    'SOURCE_HASH_MISMATCH',
    'Registered source size differs.',
  );
  const definition = await checkSetting(ctx, input.projectId, 'definition', request.checkId);
  const configuration = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  invariant(
    definition?.digest === request.expectedDefinition &&
      configuration?.digest === request.expectedConfiguration,
    'EVIDENCE_CHANGED',
    'Select the exact current check and runner configuration.',
  );
  const runner = hostedCheckRunnerSchema.parse(JSON.parse(configuration.value));
  invariant(
    runner.environmentFingerprint === request.expectedEnvironment,
    'EVIDENCE_CHANGED',
    'Select the configured runtime environment.',
  );
  const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
  invariant(
    keyId && /^[A-Z0-9_]+$/.test(keyId),
    'RUNNER_UNAVAILABLE',
    'Trusted hosted check callback configuration is unavailable.',
  );
  const id = prepared.operation.firstAttempt.ids.run!;
  const run = hostedCheckRunSchema.parse({
    schema: 1,
    id,
    projectId: input.projectId,
    actor,
    at: prepared.operation.firstAttempt.at,
    request,
    check: checkSchema.parse(JSON.parse(definition.value)),
    configuration: runner,
    keyId,
    candidate: {
      digest: row.digest,
      base: candidate.base,
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
      algorithm: candidate.algorithm,
    },
    dispatchKey: checkPin({ projectId: input.projectId, runId: id, operationId: request.operationId }),
    dispatchStarted: false,
    recoveryUsed: false,
    emptyLookups: [],
    executionId: null,
    fence: 0,
    lease: null,
    plan: null,
    planDigest: null,
    status: 'queued',
    cancelRequested: false,
    counts: { completed: 0, passed: 0, failed: 0 },
    terminalDigest: null,
    endedAt: null,
    exitCode: null,
    output: null,
    cost: { status: 'unknown' },
  });
  await ctx.db.insert('projectHostedCheckRuns', {
    projectId: input.projectId,
    runId: id,
    candidateId: request.candidateId,
    status: run.status,
    value: canonicalPayload(run),
  });
  return run;
}
