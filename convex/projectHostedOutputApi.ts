// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction } from './server';
import { mutation, action } from './cliServer';
import type { Id } from './_generated/dataModel';
import { authorizeOutput, collectorCaller, commitHostedOutput } from './projectHostedOutputStore';
import { outputMessageObject, outputKey, type OutputMessage } from '../src/hosted-check-output';
import { canonicalPayload } from '../src/hosted-source-operation';
import { r2Config, presignPut, headObject, checksumOf } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = { projectId: v.id('hostedProjects'), message: v.string(), signature: v.string() };
/** Internal steps of the verified transfer: a public collector call names its
 * signed-in account, a backend call names none. */
const internalArgs = { ...args, caller: v.optional(v.string()) };
type Input = { projectId: Id<'hostedProjects'>; message: string; signature: string };
type InternalInput = Input & { caller?: string };
/** The deployment key. Server-only: runner machines receive a derived key at
 * registration (see machineCollectorKey) and never this value. */
export const outputSigningKey = (id: string) => {
  const value = process.env[`FORGE_HOSTED_CHECK_KEY_${id}`];
  invariant(value, 'RUNNER_UNAVAILABLE', 'Trusted output key is unavailable.');
  return value;
};
/** Fixed collector only. No project-code/account credential grants signing
 * authority. Targets bind one exact immutable key, length and checksum. */
const prepareHandler = async (
  ctx: import('./_generated/server').MutationCtx,
  input: Input,
  collector: boolean,
) => {
  try {
    const caller = collector ? await collectorCaller(ctx) : undefined;
    const message = await authorizeOutput(
      ctx,
      { projectId: input.projectId, signature: input.signature, message: JSON.parse(input.message) },
      outputSigningKey,
      caller,
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
  handler: (ctx, input) => prepareHandler(ctx, input, false),
});
/** The apply entrypoint is internal to the verified transfer action. No output
 * byte body is accepted by either API. Rechecks authority after external I/O. */
export const apply = internalMutation({
  args: internalArgs,
  returns: v.string(),
  handler: async (ctx, { caller, ...input }) => {
    try {
      return canonicalPayload(
        await commitHostedOutput(
          ctx,
          { ...input, message: JSON.parse(input.message) },
          outputSigningKey,
          caller,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});
// Type-independent references keep additions to the generated API unnecessary.
const authorizedRef = makeFunctionReference<'mutation', InternalInput, string>(
  'projectHostedOutputApi:authorize',
);
const applyRef = makeFunctionReference<'mutation', InternalInput, string>('projectHostedOutputApi:apply');
export const authorize = internalMutation({
  args: internalArgs,
  returns: v.string(),
  handler: async (ctx, { caller, ...input }) => {
    try {
      return canonicalPayload(
        await authorizeOutput(
          ctx,
          { ...input, message: JSON.parse(input.message) },
          outputSigningKey,
          caller,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});
/** One 403 from log storage (clock skew at the edge, a stale signature, a brief credential
 * propagation lag) is retried once after a short backoff; a second 403 is a storage outage.
 * Healthy requests make no extra call. Every storage failure is infrastructure: the HTTP
 * handler answers 503 (reason storage), never a test failure. */
export const outputStorageRetryMs = 300;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function storeOutputObject(
  target: { url: string; headers: Record<string, string> },
  body: BodyInit,
  send: typeof fetch = fetch,
  wait = pause,
) {
  const put = () =>
    send(target.url, {
      method: 'PUT',
      headers: target.headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  let stored = await put();
  if (stored.status === 403) {
    await wait(outputStorageRetryMs);
    stored = await put();
  }
  // The signed create-only PUT enforces the sha256; 412 means this object is already stored.
  invariant(stored.ok || stored.status === 412, 'R2_VERIFY_FAILED', 'Output upload failed.');
}
export async function verifyOutputObject(
  projectId: string,
  message: OutputMessage,
  config = r2Config(),
  head = headObject,
  wait = pause,
) {
  const object = outputMessageObject(message);
  if (!object) return;
  const key = outputKey(projectId, message.runId, object);
  let observed = await head(config, key);
  if (observed.status === 'error' && 'httpStatus' in observed && observed.httpStatus === 403) {
    await wait(outputStorageRetryMs);
    observed = await head(config, key);
  }
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
  input: Input,
  collector: boolean,
): Promise<string> => {
  try {
    const selected: InternalInput = {
      projectId: input.projectId,
      message: input.message,
      signature: input.signature,
      ...(collector ? { caller: await collectorCaller(ctx) } : {}),
    };
    const message: OutputMessage = JSON.parse(await ctx.runMutation(authorizedRef, selected));
    if (outputMessageObject(message)) await verifyOutputObject(input.projectId, message);
    return await ctx.runMutation(applyRef, selected);
  } catch (error) {
    return report(error);
  }
};
export const commit = internalAction({
  args,
  returns: v.string(),
  handler: (ctx, input) => commitHandler(ctx, input, false),
});

// Signed fixed collectors may pull output targets directly. apply stays internal;
// the public commit action performs the same authoritative R2 HEAD verification.
// Both bind the signed-in caller to the run's registered machine owner.
export const workerPrepare = mutation({
  args,
  returns: v.string(),
  handler: (ctx, input) => prepareHandler(ctx, input, true),
});
export const workerCommit = action({
  args,
  returns: v.string(),
  handler: (ctx, input) => commitHandler(ctx, input, true),
});
