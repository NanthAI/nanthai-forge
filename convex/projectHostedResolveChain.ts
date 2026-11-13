// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { runConvexSourceStep } from './projectConvexSource';
import { runPreparedResolveChain } from './projectHostedResolveChainRun';

/** save-then-resolve (1eef1b43): run by the action whose commit published a save whose request names
 * the resolve that follows it (`projectSourceRun:submit`), or scheduled by that publication when no
 * such action runs it (then also as that action's delayed fallback). Prepares that sync from the
 * save's result, writes its input to R2, submits and runs its first step, so the CLI makes no second
 * round of calls. Returns the sync's publication when that step finished it. The CLI keeps its own
 * idempotent path for every case this does not finish: it replays the identical request and converges. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runResolveChain(ctx, args);
    return null;
  },
});
export async function runResolveChain(
  ctx: ActionCtx,
  args: { projectId: Id<'hostedProjects'>; actor: string; operationId: string },
): Promise<string | null> {
  return runPreparedResolveChain(ctx, args, (input, preloaded) =>
    runConvexSourceStep(ctx, input, { inline: true, preloaded: [preloaded] }),
  );
}
