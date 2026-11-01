// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { convexSourceTransport } from './projectConvexSourceTransport';
import { runSmallSourceSave } from '../src/hosted-source-small-save';
import { sourceDomainError } from './projectConvexSourceErrors';
export { dispatch } from './projectConvexSourceStore';
export { convexSourceTransport } from './projectConvexSourceTransport';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** Small saves avoid Node cold starts. Other work retains the same bounded,
 * resumable Node implementation and the begin/commit authority fence. */
export const step = internalAction({
  args: { projectId: v.id('hostedProjects'), jobId: v.string(), step: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const loaded: string | null = await ctx.runMutation(reference('projectConvexSourceStore:begin'), input);
    if (!loaded) return null;
    const state = JSON.parse(loaded),
      transport = convexSourceTransport(ctx, input, state.locations);
    let output;
    try {
      if (state.jobKind === 'save' && !state.cursor && !state.batchId)
        output = await runSmallSourceSave(state.input, transport.io);
    } catch (error) {
      const domain = sourceDomainError(error);
      if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
      await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
        ...input,
        cursor: state.cursor,
        objects: [],
        output: null,
        failure: domain.code,
      });
      return null;
    }
    if (!output) {
      // Reuse the already-authorized begin and bounded descriptors on fallback.
      await ctx.runAction(makeFunctionReference<'action'>('projectConvexSourceNode:step'), {
        ...input,
        loaded: JSON.stringify({ ...state, locations: [...transport.locations.values()] }),
      });
      return null;
    }
    await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
      ...input,
      cursor: null,
      objects: transport.outputs,
      output,
      failure: null,
    });
    return null;
  },
});
