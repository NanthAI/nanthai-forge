// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { convexSourceTransport } from './projectConvexSource';
import { runSourceTask, type SourceTaskInput } from '../src/hosted-source-fanout';
import { storeTaskData, loadTaskData } from '../src/hosted-source-task-data';
import { sourceDomainError } from './projectConvexSourceErrors';
import { sourceStorage } from './projectConvexSourceStorage';
import { logSourceFailure, withSourceFailureLog, sourceCall } from '../src/hosted-source-io-error';
import { parseSourceTaskInput } from '../src/hosted-source-task-schema';
import { sourceValidation } from '../src/hosted-source-validation';
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
  handler: async (ctx, input): Promise<null> =>
    withSourceFailureLog(
      input,
      'task',
      async () => {
        const started = performance.now();
        const loaded: string | null = await sourceCall('task-begin', () =>
          ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:begin'), input),
        );
        if (!loaded) return null;
        const state = JSON.parse(loaded),
          { io, outputs } = convexSourceTransport(ctx, input);
        const { read, store } = sourceStorage(ctx, input.projectId);
        let result: Awaited<ReturnType<typeof runSourceTask>>;
        try {
          const previous = state.progress
            ? await sourceCall('task-progress-read', () => loadTaskData(state.progress, read))
            : null;
          const taskInput = parseSourceTaskInput(
            sourceValidation('SOURCE_JOB_INVALID', () => JSON.parse(state.input) as SourceTaskInput),
          );
          result = await sourceCall('task-run', () => runSourceTask(taskInput, previous, io), {
            objects: taskInput.refs.length,
            size: taskInput.refs.reduce((n, r) => n + r.object.size, 0),
          });
          while (outputs.length)
            await sourceCall('task-stage', () =>
              ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceStore:stage'), {
                projectId: input.projectId,
                jobId: input.jobId,
                step: input.step,
                objects: outputs.splice(0, 100),
              }),
            );
          const saved =
            result.done && result.progress.states.length === 0 && !result.progress.calculations?.length
              ? null
              : await sourceCall('task-progress-store', () => storeTaskData(result.progress, store));
          await sourceCall('task-complete', () =>
            ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:complete'), {
              ...input,
              done: result.done,
              progress: result.done ? null : saved,
              output: result.done ? saved : null,
              failure: null,
            }),
          );
          return null;
        } catch (error) {
          const domain = sourceDomainError(error);
          if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
          logSourceFailure(error, input, 'task', started);
          await sourceCall('task-complete', () =>
            ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:complete'), {
              ...input,
              done: true,
              progress: null,
              output: null,
              failure: domain.code,
            }),
          );
          return null;
        }
      },
      cause =>
        ctx.runMutation(makeFunctionReference<'mutation'>('projectConvexSourceFanout:failed'), {
          ...input,
          cause,
        }),
    ),
});
