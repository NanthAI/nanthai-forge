// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, type MutationCtx, type ActionCtx } from './_generated/server';
import { mutation, action } from './cliServer';
import type { Id } from './_generated/dataModel';
import { authorizeOutputWindow, commitHostedOutputWindow } from './projectHostedOutputStore';
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
type Input = { projectId: Id<'hostedProjects'>; entries: { message: string; signature: string }[] };
function window(input: Input) {
  invariant(
    input.entries.length > 0 && input.entries.length <= 100,
    'BAD_ARGUMENT',
    'Transfer output in windows of at most 100 records.',
  );
  return input.entries.map(entry => ({ ...entry, message: JSON.parse(entry.message) }));
}
async function authorized(ctx: MutationCtx, input: Input) {
  return authorizeOutputWindow(
    ctx,
    window(input).map(entry => ({ projectId: input.projectId, ...entry })),
    outputSigningKey,
  );
}
const prepareHandler = async (ctx: MutationCtx, input: Input) => {
  try {
    const messages = await authorized(ctx, input);
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
export const prepare = internalMutation({ args, returns: v.string(), handler: prepareHandler });
export const authorize = internalMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(await authorized(ctx, input));
    } catch (error) {
      return report(error);
    }
  },
});
export const apply = internalMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      // One atomic ordered window. Every original signature, epoch, execution,
      // offset, sequence and duplicate receipt is revalidated after storage IO.
      return canonicalPayload(
        await commitHostedOutputWindow(
          ctx,
          window(input).map(entry => ({ projectId: input.projectId, ...entry })),
          outputSigningKey,
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});
const commitHandler = async (ctx: ActionCtx, input: Input): Promise<string> => {
  try {
    const messages: OutputMessage[] = JSON.parse(
      await ctx.runMutation(
        makeFunctionReference<'mutation', Input, string>('projectHostedOutputBatch:authorize'),
        input,
      ),
    );
    // Storage HEADs are external IO, not nested Convex calls; keep memory bounded.
    for (const message of messages) await verifyOutputObject(input.projectId, message);
    return await ctx.runMutation(
      makeFunctionReference<'mutation', Input, string>('projectHostedOutputBatch:apply'),
      input,
    );
  } catch (error) {
    return report(error);
  }
};
export const commit = internalAction({ args, returns: v.string(), handler: commitHandler });
export const workerPrepare = mutation({ args, returns: v.string(), handler: prepareHandler });
export const workerCommit = action({ args, returns: v.string(), handler: commitHandler });
