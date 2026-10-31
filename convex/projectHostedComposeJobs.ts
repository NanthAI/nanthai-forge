import { sourceProgress } from './projectSourceProgress';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { sourceWorkerPlan } from '../src/convex-source-provider';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation, internalAction } from './cliServer';
import { saveObject } from './projectHostedSaveStore';
import {
  loadCompose,
  writeComposeState,
  hostedComposeInput,
  composeForJob,
} from './projectHostedComposeStore';
import { enqueueSourceJob, loadSourceJob } from './projectSourceJobs';
import { publishHostedCompose } from './projectHostedComposePublish';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { blobStore } from './blobStore';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';
import { finishHostedOperation } from './projectHostedOperations';
import { findObject } from './projectObjectFind';

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() },
  jobIdentity = { projectId: v.id('hostedProjects'), jobId: v.string() };
export const submit = mutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to compose hosted source.');
      return await submitHostedCompose(ctx, { ...input, actor: user.subject });
    } catch (error) {
      return report(error);
    }
  },
});
/** Internal driver uses the same retained source job and dispatch identity. */
export async function submitHostedCompose(
  ctx: import('./_generated/server').MutationCtx,
  input: import('./projectHostedSaveStore').SaveIdentity,
) {
  const auth = input,
    { row, state, operation } = await loadCompose(ctx, auth, false);
  if (operation.terminal) return canonicalPayload(operation.terminal);
  await loadCompose(ctx, auth);
  invariant(
    state.status === 'ready' || state.status === 'submitted',
    'SOURCE_JOB_INVALID',
    'Stage every original selection page before submitting.',
  );
  if (state.status === 'ready') {
    const inputPin = savePin(hostedComposeInput(state, operation.firstAttempt.at));
    await saveObject(ctx, input.projectId, inputPin);
    const expected = operation.expected,
      operationId = state.jobOperationId,
      payload = {
        jobKind: 'compose',
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
    await writeComposeState(ctx, row._id, { ...state, status: 'submitted' });
  }
  const job = await loadSourceJob(ctx, input.projectId, row.jobId);
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'action'>(
      job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
        ? 'projectHostedComposeJobs:complete'
        : 'projectConvexSource:dispatch',
    ),
    { projectId: input.projectId, jobId: row.jobId },
  );
  return canonicalPayload(await sourceProgress(ctx, input.projectId, row.jobId, job));
}
export const publish = internalMutation({
  args: { ...jobIdentity, result: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
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
      }),
    );
  },
});
/** Only the small worker result manifest passes through the action, never source bytes. */
export const resultDownload = internalMutation({
  args: jobIdentity,
  returns: v.union(v.object({ url: v.string(), size: v.number() }), v.null()),
  handler: async (ctx, input) => {
    const row = await composeForJob(ctx, input.projectId, input.jobId);
    if (!row) return null;
    const { operation } = await loadCompose(ctx, row, false);
    if (operation.terminal) return null;
    await loadCompose(ctx, row);
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
              message: 'The original source job did not complete; its composition inputs is retained.',
            },
          },
        },
      });
      const loaded = await loadCompose(ctx, row);
      await writeComposeState(ctx, row._id, { ...loaded.state, status: 'failed' });
      return null;
    }
    invariant(
      // Batched changed-path coverage can exceed a tiny manifest. Keep the
      // signed metadata download bounded without rejecting ordinary stacks.
      job.status === 'completed' && job.output && job.output.size <= 512 * 1024,
      'SOURCE_JOB_INVALID',
      'A completed source result manifest is required.',
    );
    await saveObject(ctx, input.projectId, job.output);
    const object = await findObject(ctx, input.projectId, job.output!.sha256);
    const url =
      object?.location === 'r2' && object.r2Key
        ? await presignGet(r2Config(), object.r2Key)
        : object?.storageId
          ? await blobStore(ctx).getUrl(object.storageId)
          : null;
    invariant(url, 'SOURCE_UNAVAILABLE', 'The exact worker result is unavailable.');
    return { url, size: job.output.size };
  },
});
export const complete = internalAction({
  args: jobIdentity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input): Promise<string | null> => {
    const grant: { url: string; size: number } | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedComposeJobs:resultDownload'),
      input,
    );
    if (!grant) return null;
    const response = await fetch(grant.url, {
      headers: { 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(10000),
    });
    invariant(
      response.ok && response.body,
      'SOURCE_UNAVAILABLE',
      'Worker result download failed; retry the original composition.',
    );
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        invariant(size <= grant.size, 'SOURCE_HASH_MISMATCH', 'Worker result exceeds its exact size.');
        parts.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedComposeJobs:publish'), {
      ...input,
      result: new TextDecoder().decode(bytes),
    });
  },
});
