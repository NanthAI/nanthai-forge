// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob } from './projectSourceJobs';
import { loadSave, saveObject } from './projectHostedSaveStore';
import { saveForJob } from './projectHostedSavePublish';
import { saveObjectSchema } from '../src/hosted-save';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { r2Config, r2Enabled, r2Key, presignGet, presignPut, headObject, checksumOf } from './r2';
import { blobStore } from './blobStore';
import { isStored } from './projectObjectFields';

const args = {
  projectId: v.id('hostedProjects'),
  input: v.string(),
  executionId: v.string(),
  pin: v.object({ sha256: v.string(), size: v.number() }),
};
type Transfer = {
  projectId: Id<'hostedProjects'>;
  input: string;
  executionId: string;
  pin: { sha256: string; size: number };
};
/** Authenticated control ingress only. Every grant AND post-HEAD commit rechecks
 * original execution/fence/epoch and current contributor/project authority. */
export async function authorizeSaveTransfer(ctx: MutationCtx, request: Transfer) {
  const input = JSON.parse(request.input),
    pin = saveObjectSchema.parse(request.pin),
    job = await loadSourceJob(ctx, request.projectId, input.jobId);
  const row = await saveForJob(ctx, request.projectId, job.id);
  invariant(row && job.jobKind === 'save', 'SOURCE_JOB_INVALID', 'This is not a hosted save source job.');
  const { operation, state } = await loadSave(ctx, row);
  invariant(
    !operation.terminal &&
      state.status === 'submitted' &&
      job.operationId === state.jobOperationId &&
      job.control.actor === row.actor,
    'SOURCE_JOB_FENCED',
    'This original save is no longer running.',
  );
  const expected = {
    schema: 1,
    projectId: request.projectId,
    jobId: job.id,
    operationId: job.operationId,
    jobKind: job.jobKind,
    attempt: job.attempt,
    fence: job.fence,
    authorityEpoch: job.authorityEpoch,
    input: job.input,
    inputDigest: job.inputDigest,
    provider: job.control.provider,
    worker: job.control.worker,
    runtime: job.control.runtime,
    dispatchKey: job.control.dispatchKey,
  };
  invariant(
    canonicalPayload(input) === canonicalPayload(expected) &&
      job.status === 'running' &&
      job.executionId === request.executionId &&
      job.control.workerUntil > Date.now(),
    'SOURCE_JOB_FENCED',
    'The source transfer execution changed or expired.',
  );
  return { job, row, pin };
}
export const grant = internalMutation({
  args: { ...args, action: v.union(v.literal('read'), v.literal('upload')) },
  returns: v.object({ url: v.string(), headers: v.record(v.string(), v.string()) }),
  handler: async (ctx, input) => {
    const { pin, row } = await authorizeSaveTransfer(ctx, input);
    if (input.action === 'read') {
      // The fixed trusted reader requests only hash-pinned input/recipe closure.
      // Project membership is checked for each exact object, including recipe leaves.
      await saveObject(ctx, input.projectId, pin);
      const object = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
        .unique();
      const url =
        object?.location === 'r2' && object.r2Key
          ? await presignGet(r2Config(), object.r2Key)
          : object?.storageId
            ? await blobStore(ctx).getUrl(object.storageId)
            : null;
      invariant(url, 'SOURCE_UNAVAILABLE', 'Read a raw source object or its exact recipe leaves.');
      return { url, headers: {} };
    }
    const project = await ctx.db.get(input.projectId);
    invariant(
      r2Enabled() && project?.r2Writes,
      'SOURCE_WORKER_UNAVAILABLE',
      'Hosted source output requires the configured project object-store path.',
    );
    let object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
      .unique();
    invariant(
      !object || (!object.removed && object.size === pin.size),
      'SOURCE_HASH_MISMATCH',
      'Output differs from its immutable project binding.',
    );
    // Immutable outputs may replay after a lost PUT or HEAD reply. Reuse a raw
    // committed R2 destination; never proxy source bytes through an action.
    invariant(
      !object || object.location === 'r2',
      'SOURCE_UNAVAILABLE',
      'This output already has a different retained storage representation.',
    );
    if (!object) {
      const id = await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: pin.sha256,
        size: pin.size,
        nonce: crypto.randomUUID(),
        removed: false,
        location: 'r2',
        r2Key: r2Key(input.projectId, pin.sha256),
        r2PreparedAt: Date.now(),
      });
      object = (await ctx.db.get(id))!;
    }
    if (!object.r2Committed && object.r2SweepKey === object.r2Key) {
      const key = `${r2Key(input.projectId, pin.sha256)}/u/${crypto.randomUUID()}`;
      await ctx.db.patch(object._id, { r2Key: key, r2PreparedAt: Date.now() });
      object = { ...object, r2Key: key };
    }
    invariant(object.r2Key, 'SOURCE_UNAVAILABLE', 'Output storage binding is unavailable.');
    if (!project.r2StorageUsed) await ctx.db.patch(row.projectId, { r2StorageUsed: true });
    const target = await presignPut(r2Config(), object.r2Key, { digest: pin.sha256, size: pin.size });
    return { url: target.url, headers: target.headers };
  },
});
export const pending = internalMutation({
  args,
  returns: v.object({ key: v.string(), stored: v.boolean() }),
  handler: async (ctx, input) => {
    const { pin } = await authorizeSaveTransfer(ctx, input);
    const object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
      .unique();
    invariant(
      object &&
        !object.removed &&
        object.location === 'r2' &&
        object.r2Key &&
        object.size === pin.size &&
        object.r2SweepKey !== object.r2Key,
      'SOURCE_UNAVAILABLE',
      'Prepare the exact source output before committing.',
    );
    return { key: object.r2Key, stored: isStored(object) };
  },
});
export const verified = internalMutation({
  args: { ...args, key: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { pin } = await authorizeSaveTransfer(ctx, input);
    const object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
      .unique();
    invariant(
      object &&
        !object.removed &&
        object.location === 'r2' &&
        object.r2Key === input.key &&
        object.r2SweepKey !== input.key &&
        object.size === pin.size,
      'SOURCE_UNAVAILABLE',
      'The output binding changed during storage verification.',
    );
    if (!object.r2Committed) await ctx.db.patch(object._id, { r2Committed: true });
    return null;
  },
});
export const commit = internalAction({
  args,
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const pending: { key: string; stored: boolean } = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedSaveTransfers:pending'),
      input,
    );
    if (!pending.stored) {
      const head = await headObject(r2Config(), pending.key);
      invariant(
        head.status === 'ok' &&
          head.size === input.pin.size &&
          head.checksum === checksumOf(input.pin.sha256),
        'R2_VERIFY_FAILED',
        'The exact source output size and checksum were not confirmed.',
      );
    }
    return await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSaveTransfers:verified'), {
      ...input,
      key: pending.key,
    });
  },
});
