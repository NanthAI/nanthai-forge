// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexSourceTransport } from './projectConvexSource';
import { runSourceTask, type SourceTaskInput, type SourceTaskProgress } from '../src/hosted-source-fanout';
import { storeTaskData, loadTaskData } from '../src/hosted-source-task-data';
import { ForgeError, invariant } from '../src/errors';
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
    const read = async (id: string) => {
      const blob = await ctx.storage.get(id as Id<'_storage'>);
      invariant(blob, 'SOURCE_UNAVAILABLE', 'Source task progress is absent.');
      return new Uint8Array(await blob.arrayBuffer());
    };
    const store = (bytes: Uint8Array) =>
      ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
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
        failure: error instanceof ForgeError ? error.code : 'SOURCE_WORKER_FAILED',
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
