// SPDX-License-Identifier: Apache-2.0
// Shared source coordinator only: Node imports no V8 step registration or compose graph.
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { storeSourceBytes } from './projectSourceBytes';
import { saveBytes, savePin } from '../src/hosted-save';
const reference = (name: string) =>
  makeFunctionReference<'mutation'>(`projectHostedResolveChainStore:${name}`);
export async function runPreparedResolveChain(
  ctx: ActionCtx,
  args: { projectId: Id<'hostedProjects'>; actor: string; operationId: string },
  runStep: (
    input: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
    preloaded: { sha256: string; size: number; text: string },
  ) => Promise<string | null>,
): Promise<string | null> {
  let submitted = false;
  try {
    const prepared: string | null = await ctx.runMutation(reference('prepare'), args);
    if (!prepared) return null;
    const { operationId, input } = JSON.parse(prepared) as { operationId: string; input: unknown };
    const pin = savePin(input),
      bytes = saveBytes(input);
    await storeSourceBytes(ctx, args.projectId, bytes, pin);
    const result: { run: string | null } = JSON.parse(
      await ctx.runMutation(reference('submit'), { ...args, operationId, input: pin }),
    );
    submitted = true;
    // The step reads the input this action just wrote and HEAD-verified from memory, not from R2.
    if (!result.run) return null;
    const next = { projectId: args.projectId, jobId: result.run, step: 0 },
      preloaded = { ...pin, text: new TextDecoder().decode(bytes) };
    return await runStep(next, preloaded);
  } catch (error) {
    // After the submit the job owns recovery (its fallback step); before it, tell the CLI.
    if (!submitted)
      try {
        const code = (error as { data?: { code?: unknown } })?.data?.code;
        await ctx.runMutation(reference('failed'), {
          ...args,
          code: typeof code === 'string' ? code : 'SOURCE_UNAVAILABLE',
        });
      } catch {
        // The CLI's stall bound still ends its wait.
      }
    return null;
  }
}
