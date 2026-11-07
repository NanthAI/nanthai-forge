// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, type MutationCtx, type ActionCtx } from './server';
import { mutation, action } from './cliServer';
import type { Id } from './_generated/dataModel';
import { authorizeOutputWindow, collectorCaller, commitHostedOutputWindow } from './projectHostedOutputStore';
import { outputSigningKey, verifyOutputObject } from './projectHostedOutputApi';
import { outputMessageObject, outputKey, type OutputMessage } from '../src/hosted-check-output';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignPut, r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = {
  projectId: v.id('hostedProjects'),
  entries: v.array(v.object({ message: v.string(), signature: v.string() })),
};
/** Internal steps of the verified transfer: a public collector call names its
 * signed-in account, a backend call names none. */
const internalArgs = { ...args, caller: v.optional(v.string()) };
type Input = { projectId: Id<'hostedProjects'>; entries: { message: string; signature: string }[] };
type InternalInput = Input & { caller?: string };
function window(input: Input) {
  invariant(
    input.entries.length > 0 && input.entries.length <= 100,
    'BAD_ARGUMENT',
    'Transfer output in windows of at most 100 records.',
  );
  return input.entries.map(entry => ({ ...entry, message: JSON.parse(entry.message) }));
}
async function authorized(ctx: MutationCtx, input: Input, caller: string | undefined) {
  return authorizeOutputWindow(
    ctx,
    window(input).map(entry => ({ projectId: input.projectId, ...entry })),
    outputSigningKey,
    undefined,
    caller,
  );
}
const prepareHandler = async (ctx: MutationCtx, input: Input, collector: boolean) => {
  try {
    const caller = collector ? await collectorCaller(ctx) : undefined;
    const messages = await authorized(ctx, input, caller);
    const targets = [];
    for (const message of messages) {
      const object = outputMessageObject(message);
      targets.push({
        object,
        target: object
          ? await presignPut(r2Config(), outputKey(input.projectId, message.runId, object), {
              digest: object.sha256,
              size: object.size,
            })
          : null,
      });
    }
    return canonicalPayload(targets);
  } catch (error) {
    return report(error);
  }
};
export const prepare = internalMutation({
  args,
  returns: v.string(),
  handler: (ctx, input) => prepareHandler(ctx, input, false),
});
export const authorize = internalMutation({
  args: internalArgs,
  returns: v.string(),
  handler: async (ctx, { caller, ...input }) => {
    try {
      return canonicalPayload(await authorized(ctx, input, caller));
    } catch (error) {
      return report(error);
    }
  },
});
export const apply = internalMutation({
  args: internalArgs,
  returns: v.string(),
  handler: async (ctx, { caller, ...input }) => {
    try {
      // One atomic ordered window. Every original signature, epoch, execution,
      // offset, sequence and duplicate receipt is revalidated after storage IO.
      return canonicalPayload(
        await commitHostedOutputWindow(
          ctx,
          window(input).map(entry => ({ projectId: input.projectId, ...entry })),
          outputSigningKey,
          undefined,
          caller,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});
const commitHandler = async (ctx: ActionCtx, input: Input, collector: boolean): Promise<string> => {
  try {
    const selected: InternalInput = {
      projectId: input.projectId,
      entries: input.entries,
      ...(collector ? { caller: await collectorCaller(ctx) } : {}),
    };
    const messages: OutputMessage[] = JSON.parse(
      await ctx.runMutation(
        makeFunctionReference<'mutation', InternalInput, string>('projectHostedOutputBatch:authorize'),
        selected,
      ),
    );
    // Storage HEADs are external IO, not nested Convex calls; keep memory bounded.
    for (const message of messages) await verifyOutputObject(input.projectId, message);
    return await ctx.runMutation(
      makeFunctionReference<'mutation', InternalInput, string>('projectHostedOutputBatch:apply'),
      selected,
    );
  } catch (error) {
    return report(error);
  }
};
export const commit = internalAction({
  args,
  returns: v.string(),
  handler: (ctx, input) => commitHandler(ctx, input, false),
});
// Public collector entrypoints bind the signed-in caller to the run's machine owner.
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
