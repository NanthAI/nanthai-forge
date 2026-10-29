// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { actionsSession, sessionArgs } from './projectHostedActionsSession';
import { outputHead, rootForOutput, commitHostedOutputWindow } from './projectHostedOutputStore';
import { outputMessage, signOutput, outputRootObject, outputKey } from '../src/hosted-check-output';
import { outputSigningKey } from './projectHostedOutputApi';
import { hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignPut, r2Config } from './r2';
import { invariant } from '../src/errors';
export const prepare = internalMutation({
  args: sessionArgs,
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input);
    const head = await outputHead(ctx, input);
    if (head?.final) return null;
    invariant(
      hostedCheckTerminal(run) && run.executionId && (head?.streams ?? 0) === (head?.sealed ?? 0),
      'EVIDENCE_CHANGED',
      'Finalize only settled output with complete seals.',
    );
    const root = rootForOutput(input, run.executionId, head),
      object = outputRootObject(root);
    return {
      root,
      target: await presignPut(r2Config(), outputKey(input.projectId, run.id, object), {
        digest: object.sha256,
        size: object.size,
      }),
    };
  },
});
export const apply = internalMutation({
  args: { ...sessionArgs, root: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input);
    const root = JSON.parse(input.root);
    const message = outputMessage(run, { kind: 'final', root });
    await commitHostedOutputWindow(
      ctx,
      [{ projectId: input.projectId, message, signature: signOutput(message, outputSigningKey(run.keyId)) }],
      outputSigningKey,
    );
    invariant(
      canonicalPayload(root) === input.root,
      'EVIDENCE_CHANGED',
      'Retain the original canonical output root.',
    );
    return null;
  },
});
