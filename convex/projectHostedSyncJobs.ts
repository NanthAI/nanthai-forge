// SPDX-License-Identifier: Apache-2.0
import { sourceRetryFailureMessage } from '../src/hosted-source-retry';
import { sourceProgress } from './projectSourceProgress';
import { v } from 'convex/values';
import { sourceWorkerPlan } from '../src/convex-source-provider';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation, internalAction } from './cliServer';
import { saveObject, type SaveIdentity } from './projectHostedSaveStore';
import { startSubmittedSource } from './projectSourceSubmitStart';
import type { MutationCtx } from './server';
import { loadSync, writeSyncState, hostedSyncInput, syncForJob } from './projectHostedSyncStore';
import { enqueueSourceJob, loadSourceJob } from './projectSourceJobs';
import { publishSyncJob } from './projectHostedSyncPublish';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { blobStore } from './blobStore';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { readExactObject } from './projectR2ExactRead';
import { report } from './errors';
import { finishHostedOperation } from './projectHostedOperations';
import { findObject } from './projectObjectFind';
import { packHeaders, packRange, type PackRange } from '../src/object-pack-range';

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() },
  jobIdentity = { projectId: v.id('hostedProjects'), jobId: v.string() };
export const submit = mutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to sync hosted source.');
      return (await submitHostedSync(ctx, { ...input, actor: user.subject })).payload;
    } catch (error) {
      return report(error);
    }
  },
});
/** Submit, as the public mutation, inside the submitting action's transaction (`inline`), or for a
 * resolve the server chained after its save. */
export async function submitHostedSync(
  ctx: MutationCtx,
  auth: SaveIdentity,
  inline = false,
): Promise<{ payload: string; run: string | null }> {
  const input = auth,
    { row, state, operation } = await loadSync(ctx, auth, false);
  if (operation.terminal) return { payload: canonicalPayload(operation.terminal), run: null };
  await loadSync(ctx, auth);
  invariant(
    state.status === 'ready' || state.status === 'submitted',
    'SOURCE_JOB_INVALID',
    'Prepare the original sync before submitting.',
  );
  if (state.status === 'ready') {
    const inputPin = savePin(hostedSyncInput(state, operation.firstAttempt.at));
    await saveObject(ctx, input.projectId, inputPin);
    const expected = operation.expected,
      operationId = state.jobOperationId,
      payload = {
        jobKind: 'sync',
        input: inputPin,
        inputDigest: inputPin.sha256,
        ...sourceWorkerPlan(process.env),
      };
    await enqueueSourceJob(ctx, {
      ...auth,
      request: {
        schema: 1,
        projectId: input.projectId,
        actor: auth.actor,
        operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      },
      payload,
      firstAttempt: {
        projectId: input.projectId,
        operationId,
        id: row.jobId,
        parentAttemptId: null,
        at: operation.firstAttempt.at,
        expected,
        ids: { job: row.jobId },
      },
    });
    await writeSyncState(ctx, row._id, { ...state, status: 'submitted', submittedAt: Date.now() });
  }
  const started = await startSubmittedSource(
    ctx,
    input.projectId,
    row.jobId,
    'projectHostedSyncJobs',
    inline,
  );
  return {
    payload: canonicalPayload(await sourceProgress(ctx, input.projectId, row.jobId, started.job)),
    run: started.run ? row.jobId : null,
  };
}
export const publish = internalMutation({
  args: { ...jobIdentity, result: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, input) => publishSyncJob(ctx, input),
});
/** Only the small worker result manifest passes through the action, never source bytes. */
export const resultDownload = internalMutation({
  args: jobIdentity,
  returns: v.union(
    v.object({
      url: v.string(),
      size: v.number(),
      range: v.optional(v.object({ offset: v.number(), total: v.number() })),
    }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    const row = await syncForJob(ctx, input.projectId, input.jobId);
    if (!row) return null;
    const { operation } = await loadSync(ctx, row, false);
    if (operation.terminal) return null;
    await loadSync(ctx, row);
    const job = await loadSourceJob(ctx, input.projectId, input.jobId);
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (row.culpritRunId)
        await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:advance'), {
          projectId: row.projectId,
          runId: row.culpritRunId,
        });
      await finishHostedOperation(ctx, {
        projectId: row.projectId,
        actor: row.actor,
        operationId: row.operationId,
        receipt: {
          attemptId: operation.firstAttempt.id,
          at: operation.firstAttempt.at,
          outcome: {
            status: 'failed',
            error: {
              code: job.control.failureCode ?? 'SOURCE_JOB_CANCELLED',
              message:
                job.control.failureCode === 'SOURCE_RETRY_EXHAUSTED'
                  ? sourceRetryFailureMessage(job.control.failureCause)
                  : (job.control.failureReason ??
                    'The original source job did not complete; its sync inputs are retained.'),
            },
          },
        },
      });
      const loaded = await loadSync(ctx, row);
      await writeSyncState(ctx, row._id, { ...loaded.state, status: 'failed' });
      return null;
    }
    invariant(
      job.status === 'completed' && job.output && job.output.size <= 4096,
      'SOURCE_JOB_INVALID',
      'A completed source result manifest is required.',
    );
    await saveObject(ctx, input.projectId, job.output);
    const object = await findObject(ctx, input.projectId, job.output!.sha256);
    const url =
      object?.location === 'r2' && object.r2Key
        ? await presignGet(r2Config(), object.r2Key, packHeaders(packRange(object), object.size))
        : object?.storageId
          ? await blobStore(ctx).getUrl(object.storageId)
          : null;
    invariant(url, 'SOURCE_UNAVAILABLE', 'The exact worker result is unavailable.');
    return { url, size: job.output.size, ...(object?.pack ? { range: packRange(object)! } : {}) };
  },
});
export const complete = internalAction({
  args: jobIdentity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input): Promise<string | null> => {
    const grant: { url: string; size: number; range?: PackRange } | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedSyncJobs:resultDownload'),
      input,
    );
    if (!grant) return null;
    const bytes = await readExactObject(grant, {
      failed: 'Worker result download failed; retry the original sync.',
      exceeds: 'Worker result exceeds its exact size.',
    });
    return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSyncJobs:publish'), {
      ...input,
      result: new TextDecoder().decode(bytes),
    });
  },
});
