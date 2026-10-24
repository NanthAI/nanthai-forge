// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation, internalAction } from './cliServer';
import { saveObject } from './projectHostedSaveStore';
import { loadSync, writeSyncState, hostedSyncInput, syncForJob } from './projectHostedSyncStore';
import { enqueueSourceJob, loadSourceJob } from './projectSourceJobs';
import { publishHostedSync } from './projectHostedSyncPublish';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { blobStore } from './blobStore';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';
import { finishHostedOperation } from './projectHostedOperations';

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() },
  jobIdentity = { projectId: v.id('hostedProjects'), jobId: v.string() };
export const submit = mutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to sync hosted source.');
      const auth = { ...input, actor: user.subject },
        { row, state, operation } = await loadSync(ctx, auth, false);
      if (operation.terminal) return canonicalPayload(operation.terminal);
      await loadSync(ctx, auth);
      invariant(
        state.status === 'ready' || state.status === 'submitted',
        'SOURCE_JOB_INVALID',
        'Prepare the original sync before submitting.',
      );
      if (state.status === 'ready') {
        const inputPin = savePin(hostedSyncInput(state, operation.firstAttempt.at));
        await saveObject(ctx, input.projectId, inputPin);
        const worker = process.env.FORGE_SOURCE_WORKER,
          runtime = process.env.FORGE_SOURCE_RUNTIME,
          keyId = process.env.FORGE_SOURCE_KEY_ID;
        invariant(
          worker && runtime && keyId,
          'SOURCE_WORKER_UNAVAILABLE',
          'The pinned Modal source worker is not configured.',
        );
        const expected = operation.expected,
          operationId = state.jobOperationId,
          payload = {
            jobKind: 'sync',
            input: inputPin,
            inputDigest: inputPin.sha256,
            provider: 'modal',
            worker,
            runtime,
            keyId,
            workerLeaseMs: 60000,
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
        await writeSyncState(ctx, row._id, { ...state, status: 'submitted' });
      }
      const job = await loadSourceJob(ctx, input.projectId, row.jobId);
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>(
          job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
            ? 'projectHostedSyncJobs:complete'
            : 'projectModalSource:dispatch',
        ),
        { projectId: input.projectId, jobId: row.jobId },
      );
      return canonicalPayload({ status: 'submitted', jobId: row.jobId });
    } catch (error) {
      return report(error);
    }
  },
});
export const publish = internalMutation({
  args: { ...jobIdentity, result: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const row = await syncForJob(ctx, input.projectId, input.jobId);
    if (!row) return null;
    return canonicalPayload(
      await publishHostedSync(ctx, {
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
    const row = await syncForJob(ctx, input.projectId, input.jobId);
    if (!row) return null;
    const { operation } = await loadSync(ctx, row, false);
    if (operation.terminal) return null;
    await loadSync(ctx, row);
    const job = await loadSourceJob(ctx, input.projectId, input.jobId);
    if (job.status === 'failed' || job.status === 'cancelled') {
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
              message: 'The original source job did not complete; its sync inputs are retained.',
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
    const object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q =>
        q.eq('projectId', input.projectId).eq('digest', job.output!.sha256),
      )
      .unique();
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
      makeFunctionReference<'mutation'>('projectHostedSyncJobs:resultDownload'),
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
      'Worker result download failed; retry the original sync.',
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
    return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSyncJobs:publish'), {
      ...input,
      result: new TextDecoder().decode(bytes),
    });
  },
});
