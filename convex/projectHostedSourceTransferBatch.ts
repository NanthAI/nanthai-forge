// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction } from './_generated/server';
import { authorizeSourceTransfer, sourceTransferGrant } from './projectHostedSaveTransfers';
import { saveObject } from './projectHostedSaveStore';
import { saveObjectSchema } from '../src/hosted-save';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { isStored } from './projectObjectFields';
import { r2Config, headObject, checksumOf } from './r2';
import { findObject, objectRow } from './projectObjectFind';

const identity = { projectId: v.id('hostedProjects'), input: v.string(), executionId: v.string() };
const pin = v.object({ sha256: v.string(), size: v.number() });
const grantValue = v.union(
  v.object({ url: v.string(), headers: v.record(v.string(), v.string()) }),
  v.object({ stored: v.literal(true) }),
);
function page(length: number) {
  invariant(length <= 100, 'BAD_ARGUMENT', 'Transfer source in pages of at most 100.');
}
export const describe = internalMutation({
  args: { ...identity, digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    page(input.digests.length);
    await authorizeSourceTransfer(ctx, input);
    const result = [];
    for (const sha256 of input.digests) {
      invariant(/^[0-9a-f]{64}$/.test(sha256), 'BAD_ARGUMENT', 'Select exact source digests.');
      result.push(await saveObject(ctx, input.projectId, { sha256 }));
    }
    return canonicalPayload(result);
  },
});
export const grant = internalMutation({
  args: { ...identity, pins: v.array(pin), action: v.union(v.literal('read'), v.literal('upload')) },
  returns: v.array(grantValue),
  handler: async (ctx, input) => {
    page(input.pins.length);
    const authority = await authorizeSourceTransfer(ctx, input);
    const result = [];
    for (const pin of input.pins) result.push(await sourceTransferGrant(ctx, { ...input, pin }, authority));
    return result;
  },
});
const pendingValue = v.object({ pin, key: v.string(), stored: v.boolean() });
export const pending = internalMutation({
  args: { ...identity, pins: v.array(pin) },
  returns: v.array(pendingValue),
  handler: async (ctx, input) => {
    page(input.pins.length);
    await authorizeSourceTransfer(ctx, input);
    const result = [];
    for (const value of input.pins) {
      const pin = saveObjectSchema.parse(value);
      const object = await findObject(ctx, input.projectId, pin.sha256);
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
      result.push({ pin, key: object.r2Key, stored: isStored(object) });
    }
    return result;
  },
});
export const verified = internalMutation({
  args: { ...identity, objects: v.array(pendingValue) },
  returns: v.null(),
  handler: async (ctx, input) => {
    page(input.objects.length);
    await authorizeSourceTransfer(ctx, input);
    for (const expected of input.objects) {
      const pin = saveObjectSchema.parse(expected.pin);
      const object = await findObject(ctx, input.projectId, pin.sha256);
      invariant(
        object &&
          !object.removed &&
          object.location === 'r2' &&
          object.r2Key === expected.key &&
          object.r2SweepKey !== expected.key &&
          object.size === pin.size,
        'SOURCE_UNAVAILABLE',
        'The output binding changed during storage verification.',
      );
      if (!object.r2Committed) await ctx.db.patch((await objectRow(ctx, object))._id, { r2Committed: true });
    }
    return null;
  },
});
export const commit = internalAction({
  args: { ...identity, pins: v.array(pin) },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const objects: { pin: { sha256: string; size: number }; key: string; stored: boolean }[] =
      await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedSourceTransferBatch:pending'),
        input,
      );
    for (const object of objects) {
      if (object.stored) continue;
      const head = await headObject(r2Config(), object.key);
      invariant(
        head.status === 'ok' &&
          head.size === object.pin.size &&
          head.checksum === checksumOf(object.pin.sha256),
        'R2_VERIFY_FAILED',
        'The exact source output size and checksum were not confirmed.',
      );
    }
    return ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedSourceTransferBatch:verified'), {
      projectId: input.projectId,
      input: input.input,
      executionId: input.executionId,
      objects,
    });
  },
});
