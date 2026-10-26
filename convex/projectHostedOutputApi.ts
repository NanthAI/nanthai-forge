// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation } from './_generated/server';
import { mutation, action } from './cliServer';
import type { Id } from './_generated/dataModel';
import { authorizeOutput, commitHostedOutput } from './projectHostedOutputStore';
import { outputMessageObject, outputKey, type OutputMessage } from '../src/hosted-check-output';
import { canonicalPayload } from '../src/hosted-source-operation';
import { r2Config, presignPut, headObject, checksumOf } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = { projectId: v.id('hostedProjects'), message: v.string(), signature: v.string() };
export const outputSigningKey = (id: string) => {
  const value = process.env[`FORGE_HOSTED_CHECK_KEY_${id}`];
  invariant(value, 'RUNNER_UNAVAILABLE', 'Trusted output key is unavailable.');
  return value;
};
/** Fixed collector only. No project-code/account credential grants signing
 * authority. Targets bind one exact immutable key, length and checksum. */
const prepareHandler = async (
  ctx: import('./_generated/server').MutationCtx,
  input: { projectId: Id<'hostedProjects'>; message: string; signature: string },
) => {
  try {
    const message = await authorizeOutput(
      ctx,
      { ...input, message: JSON.parse(input.message) },
      outputSigningKey,
    );
    const object = outputMessageObject(message);
    return canonicalPayload({
      object,
      target: object
        ? await presignPut(r2Config(), outputKey(input.projectId, message.runId, object), {
            digest: object.sha256,
            size: object.size,
          })
        : null,
    });
  } catch (error) {
    return report(error);
  }
};
export const prepare = internalMutation({
  args,
  returns: v.string(),
  handler: prepareHandler,
});
/** The apply entrypoint is internal to the verified transfer action. No output
 * byte body is accepted by either API. Rechecks authority after external I/O. */
export const apply = internalMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(
        await commitHostedOutput(ctx, { ...input, message: JSON.parse(input.message) }, outputSigningKey),
      );
    } catch (error) {
      return report(error);
    }
  },
});
// Type-independent references keep additions to the generated API unnecessary.
const authorizedRef = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; message: string; signature: string },
  string
>('projectHostedOutputApi:authorize');
const applyRef = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; message: string; signature: string },
  string
>('projectHostedOutputApi:apply');
export const authorize = internalMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(
        await authorizeOutput(ctx, { ...input, message: JSON.parse(input.message) }, outputSigningKey),
      );
    } catch (error) {
      return report(error);
    }
  },
});
export async function verifyOutputObject(
  projectId: string,
  message: OutputMessage,
  config = r2Config(),
  head = headObject,
) {
  const object = outputMessageObject(message);
  if (!object) return;
  const observed = await head(config, outputKey(projectId, message.runId, object));
  invariant(
    observed.status !== 'missing',
    'R2_OBJECT_MISSING',
    'Output upload is not stored yet. Retry the original chunk.',
  );
  invariant(observed.status === 'ok', 'R2_VERIFY_FAILED', 'Output storage could not confirm this upload.');
  invariant(observed.size === object.size, 'R2_OBJECT_SIZE_MISMATCH', 'Output upload size differs.');
  // The checksum is enforced on the create-only signed PUT even when HEAD
  // omits it; readers additionally verify every downloaded chunk themselves.
  invariant(
    !observed.checksum || observed.checksum === checksumOf(object.sha256),
    'R2_OBJECT_CHECKSUM_MISMATCH',
    'Output upload checksum differs.',
  );
}
const commitHandler = async (
  ctx: import('./_generated/server').ActionCtx,
  input: { projectId: Id<'hostedProjects'>; message: string; signature: string },
): Promise<string> => {
  try {
    const message: OutputMessage = JSON.parse(await ctx.runMutation(authorizedRef, input));
    if (outputMessageObject(message)) await verifyOutputObject(input.projectId, message);
    return await ctx.runMutation(applyRef, input);
  } catch (error) {
    return report(error);
  }
};
export const commit = internalAction({ args, returns: v.string(), handler: commitHandler });

// Signed fixed collectors may pull output targets directly. apply stays internal;
// the public commit action performs the same authoritative R2 HEAD verification.
export const workerPrepare = mutation({ args, returns: v.string(), handler: prepareHandler });
export const workerCommit = action({ args, returns: v.string(), handler: commitHandler });
