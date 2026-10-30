// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { convexSourceTransport } from './projectConvexSource';
import { runSourceTask, type SourceTaskInput, type SourceTaskProgress } from '../src/hosted-source-fanout';
import { storeTaskData, loadTaskData } from '../src/hosted-source-task-data';
import { sourceDomainError } from './projectConvexSourceErrors';
import { sourceStorage } from './projectConvexSourceStorage';
const args = {
  projectId: v.id('hostedProjects'),
  jobId: v.string(),
  step: v.number(),
  index: v.number(),
  generation: v.number(),
};
export const run = internalAction({
  args,
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const loaded: string | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectConvexSourceFanout:begin'),
      input,
    );
    if (!loaded) return null;
    const state = JSON.parse(loaded),
      { io, outputs } = convexSourceTransport(ctx, input);
    const { read, store } = sourceStorage(ctx, input.projectId);
    let result;
    try {
      const previous = state.progress ? await loadTaskData<SourceTaskProgress>(state.progress, read) : null;
      result = await runSourceTask(JSON.parse(state.input) as SourceTaskInput, previous, io);
    } catch (error) {
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:complete'), {
        ...input,
        done: true,
        progress: null,
        output: null,
        failure: sourceDomainError(error)?.code ?? 'SOURCE_WORKER_FAILED',
      });
      return null;
    }
    while (outputs.length)
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceStore:stage'), {
        projectId: input.projectId,
        jobId: input.jobId,
        step: input.step,
        objects: outputs.splice(0, 100),
      });
    const saved =
      result.done && result.progress.states.length === 0 && !result.progress.calculations?.length
        ? null
        : await storeTaskData(result.progress, store);
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:complete'), {
      ...input,
      done: result.done,
      progress: result.done ? null : saved,
      output: result.done ? saved : null,
      failure: null,
    });
    return null;
  },
});
