// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { writableHostedCheck } from './projectHostedCheckStore';
import { saveObject } from './projectHostedSaveStore';
import {
  hostedActionsTransferSchema,
  hostedActionsMappingSchema,
  actionsMappingMatches,
} from '../src/hosted-actions';
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
/** Fixed-worker ingress derives project/lease identity from its authenticated
 * request. Every descriptor/grant/commit rechecks current actor/epoch and lease.
 * The same R2 protocol as source workers carries bytes directly, outside Convex. */
export async function authorizeActionsTransfer(
  ctx: MutationCtx,
  request: Omit<Transfer, 'pin'> & { pin?: Transfer['pin'] },
) {
  const input = hostedActionsTransferSchema.parse(JSON.parse(request.input));
  const { run } = await writableHostedCheck(ctx, { projectId: request.projectId, runId: input.runId });
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', request.projectId).eq('runId', input.runId))
    .unique();
  invariant(row, 'SOURCE_JOB_FENCED', 'Claim the original Actions export before transfer.');
  const mapping = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  actionsMappingMatches(mapping, run);
  invariant(
    input.dispatchKey === run.dispatchKey &&
      input.owner === mapping.lease.owner &&
      request.executionId === input.owner &&
      input.token === mapping.lease.token &&
      mapping.lease.until > Date.now(),
    'SOURCE_JOB_FENCED',
    'Actions transfer lease changed or expired.',
  );
  return { mapping, pin: request.pin ? saveObjectSchema.parse(request.pin) : null };
}
export const describe = internalMutation({
  args: { projectId: args.projectId, input: args.input, executionId: args.executionId, sha256: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    await authorizeActionsTransfer(ctx, input);
    invariant(/^[0-9a-f]{64}$/.test(input.sha256), 'BAD_ARGUMENT', 'Select an exact source digest.');
    return canonicalPayload(await saveObject(ctx, input.projectId, { sha256: input.sha256 }));
  },
});
export const grant = internalMutation({
  args: { ...args, action: v.union(v.literal('read'), v.literal('upload')) },
  returns: v.union(
    v.object({ url: v.string(), headers: v.record(v.string(), v.string()) }),
    v.object({ stored: v.literal(true) }),
  ),
  handler: async (ctx, input) => {
    const { pin } = await authorizeActionsTransfer(ctx, input);
    invariant(pin, 'BAD_ARGUMENT', 'Select exact object bytes.');
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
    let object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', pin.sha256))
      .unique();
    invariant(
      !object || (!object.removed && object.size === pin.size),
      'SOURCE_HASH_MISMATCH',
      'Output differs from its immutable project binding.',
    );
    // A compose can regenerate bytes already retained in any storage format.
    // Keep save-job replies compatible with their previously pinned worker image.
    if (object && isStored(object)) return { stored: true as const };
    const project = await ctx.db.get(input.projectId);
    invariant(
      r2Enabled() && project?.r2Writes,
      'SOURCE_WORKER_UNAVAILABLE',
      'Hosted source output requires the configured project object-store path.',
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
    if (!project.r2StorageUsed) await ctx.db.patch(input.projectId, { r2StorageUsed: true });
    const target = await presignPut(r2Config(), object.r2Key, { digest: pin.sha256, size: pin.size });
    return { url: target.url, headers: target.headers };
  },
});
export const pending = internalMutation({
  args,
  returns: v.object({ key: v.string(), stored: v.boolean() }),
  handler: async (ctx, input) => {
    const { pin } = await authorizeActionsTransfer(ctx, input);
    invariant(pin, 'BAD_ARGUMENT', 'Select exact object bytes.');
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
    const { pin } = await authorizeActionsTransfer(ctx, input);
    invariant(pin, 'BAD_ARGUMENT', 'Select exact object bytes.');
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
      makeFunctionReference<'mutation'>('projectHostedActionsTransfers:pending'),
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
    return await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsTransfers:verified'),
      {
        ...input,
        key: pending.key,
      },
    );
  },
});
