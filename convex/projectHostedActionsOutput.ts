// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { outputHead, rootForOutput, commitHostedOutputWindow } from './projectHostedOutputStore';
import { outputMessage, signOutput, outputRootObject, outputKey } from '../src/hosted-check-output';
import { outputSigningKey } from './projectHostedOutputApi';
import { hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignPut, r2Config } from './r2';
import { invariant } from '../src/errors';
/** The final output root and its presigned PUT target for a terminal run: null when the
 * output is already final, undefined when its seals are not complete (prepare refuses). */
export async function finalOutputTarget(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; runId: string },
  run: HostedCheckRun,
) {
  const head = await outputHead(ctx, input);
  if (head?.final) return null;
  if (!(hostedCheckTerminal(run) && run.executionId && (head?.streams ?? 0) === (head?.sealed ?? 0)))
    return undefined;
  const root = rootForOutput(input, run.executionId, head),
    object = outputRootObject(root);
  return {
    root,
    target: await presignPut(r2Config(), outputKey(input.projectId, run.id, object), {
      digest: object.sha256,
      size: object.size,
    }),
  };
}
export const prepare = internalMutation({
  args: sessionArgs,
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input);
    const final = await finalOutputTarget(ctx, input, run);
    invariant(final !== undefined, 'EVIDENCE_CHANGED', 'Finalize only settled output with complete seals.');
    return final;
  },
});
export const apply = internalMutation({
  args: { ...sessionArgs, root: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await actionsSession(ctx, input),
      { run } = selected;
    const root = JSON.parse(input.root);
    const message = outputMessage(run, { kind: 'final', root });
    await commitHostedOutputWindow(
      ctx,
      [
        {
          projectId: input.projectId,
          message,
          signature: signOutput(message, outputSigningKey(run.keyId)),
        },
      ],
      outputSigningKey,
      selected,
    );
    invariant(
      canonicalPayload(root) === input.root,
      'EVIDENCE_CHANGED',
      'Retain the original canonical output root.',
    );
    return null;
  },
});
