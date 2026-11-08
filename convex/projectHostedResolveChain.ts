// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './server';
import { storeSourceBytes } from './projectSourceBytes';
import { runConvexSourceStep } from './projectConvexSource';
import { saveBytes, savePin } from '../src/hosted-save';

const reference = (name: string) =>
  makeFunctionReference<'mutation'>(`projectHostedResolveChainStore:${name}`);

/** save-then-resolve (1eef1b43): scheduled by a completed save whose request names the resolve
 * that follows it. Prepares that sync from the save's result, writes its input to R2, submits and
 * runs its first step, so the CLI makes no second round of calls. The CLI keeps its own idempotent
 * path for every case this does not finish: it replays the identical request and converges. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let submitted = false;
    try {
      const prepared: string | null = await ctx.runMutation(reference('prepare'), args);
      if (!prepared) return null;
      const { operationId, input } = JSON.parse(prepared) as { operationId: string; input: unknown };
      const pin = savePin(input);
      await storeSourceBytes(ctx, args.projectId, saveBytes(input), pin);
      const result: { run: string | null } = JSON.parse(
        await ctx.runMutation(reference('submit'), { ...args, operationId, input: pin }),
      );
      submitted = true;
      if (result.run)
        await runConvexSourceStep(ctx, { projectId: args.projectId, jobId: result.run, step: 0 });
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
    }
    return null;
  },
});
