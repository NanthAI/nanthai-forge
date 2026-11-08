// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexSourceTransport } from './projectConvexSourceTransport';
import { runSmallSourceSave } from '../src/hosted-source-small-save';
import { sourceDomainError } from './projectConvexSourceErrors';
import { logSourceFailure, logSourceStep, withSourceFailureLog } from '../src/hosted-source-io-error';
export { dispatch } from './projectConvexSourceStore';
export { convexSourceTransport } from './projectConvexSourceTransport';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** Small saves avoid Node cold starts. Other work retains the same bounded,
 * resumable Node implementation and the begin/commit authority fence. */
export const step = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.optional(v.number()),
  },
  returns: v.null(),
  handler: (ctx, input) => runConvexSourceStep(ctx, input),
});
/** One step of the execution: the scheduled `step`, or the first step run by the action that submitted
 * the job (no scheduler wait; its delayed fallback covers that action dying). */
export async function runConvexSourceStep(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; jobId: string; step: number; generation?: number },
): Promise<null> {
  let delegated = false,
    generation = input.generation ?? 0;
  return withSourceFailureLog(
    input,
    'small-save',
    async () => {
      const started = performance.now();
      const loaded: string | null = await ctx.runMutation(reference('projectConvexSourceStore:begin'), input);
      if (!loaded) return null;
      const state = JSON.parse(loaded);
      generation = state.generation ?? generation;
      input = { ...input, generation };
      const transport = convexSourceTransport(ctx, input, state.locations, undefined, {
        overlapWrites: true,
      });
      let output;
      try {
        if (state.jobKind === 'save' && !state.cursor && !state.batchId)
          output = await runSmallSourceSave(
            state.input,
            transport.io,
            state.locations
              .slice(1)
              .map(
                (location: { descriptor: { object: { sha256: string; size: number } } }) =>
                  location.descriptor.object,
              ),
          );
        if (!output) {
          // Reuse the already-authorized begin and bounded descriptors on fallback.
          delegated = true;
          await transport.settle();
          await ctx.runAction(makeFunctionReference<'action'>('projectConvexSourceNode:step'), {
            ...input,
            loaded: JSON.stringify({ ...state, locations: [...transport.locations.values()] }),
            delegatedAt: Date.now(),
          });
          return null;
        }
        await transport.settle();
        const outputCount = transport.outputs.length;
        const resultText = transport.smallOutput(output);
        await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
          ...input,
          cursor: null,
          objects: transport.outputs,
          output,
          failure: null,
          timing: { ...transport.clock.value(), phase: 'input>done', stop: 'done' },
          ...(resultText === null ? {} : { result: resultText }),
        });
        logSourceStep(input, {
          runtime: 'v8',
          kind: state.jobKind ?? null,
          from: 'input',
          to: 'done',
          objects: transport.reads.objects,
          bytes: transport.reads.bytes,
          outputs: outputCount,
          started,
        });
        return null;
      } catch (error) {
        if (delegated) throw error;
        const domain = sourceDomainError(error);
        if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
        logSourceFailure(error, input, 'small-save', started);
        await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
          ...input,
          cursor: state.cursor,
          objects: [],
          output: null,
          failure: domain.code,
        });
        return null;
      }
    },
    cause =>
      delegated
        ? Promise.resolve()
        : ctx.runMutation(reference('projectConvexSourceStore:failed'), { ...input, generation, cause }),
  );
}
