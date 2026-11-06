// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import {
  initialSourceStep,
  enqueueSourceObject,
  runSourceStep,
  type SourceStepCursor,
} from '../src/hosted-source-step';
import { applySourceFanout, type SourceFanout, type SourceTaskProgress } from '../src/hosted-source-fanout';
import { loadTaskData } from '../src/hosted-source-task-data';
import { sourceStorage } from './projectConvexSourceStorage';
import { convexSourceTransport } from './projectConvexSourceTransport';
import {
  loadSourceProgress,
  saveSourceProgress,
  type SourceProgress,
} from '../src/hosted-source-step-progress';
import { invariant } from '../src/errors';
import { sourceDomainError } from './projectConvexSourceErrors';
import { logSourceFailure, logSourceStep, withSourceFailureLog } from '../src/hosted-source-io-error';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string() };
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
export const step = internalAction({
  args: { ...identity, step: v.number(), generation: v.optional(v.number()), loaded: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    let generation = args.generation ?? 0;
    return withSourceFailureLog(
      args,
      'step',
      async () => {
        const started = performance.now();
        const { loaded: supplied, ...input } = args;
        const loaded: string | null =
          supplied ?? (await ctx.runMutation(reference('projectConvexSourceStore:begin'), input));
        if (!loaded) return null;
        const state = JSON.parse(loaded);
        generation = state.generation ?? generation;
        input.generation = generation;
        const { io, outputs } = convexSourceTransport(ctx, input, state.locations),
          durable = sourceStorage(ctx, input.projectId);
        let cursor: SourceStepCursor = initialSourceStep(state.input),
          progress: SourceProgress | null = null;
        let result,
          fanout: SourceFanout | null = null;
        io.fanout = plan => {
          fanout = plan;
        };
        try {
          if (state.cursor) {
            const loaded = await loadSourceProgress(await durable.read(state.cursor), durable.read);
            cursor = loaded.cursor;
            progress = loaded.value;
          }
          if (state.batchId) {
            const joined = JSON.parse(
              await ctx.runMutation(reference('projectConvexSourceFanout:results'), input),
            );
            invariant(
              !joined.failure,
              joined.failure ?? 'SOURCE_WORKER_FAILED',
              'A bounded source step failed.',
            );
            const results: SourceTaskProgress[] = [];
            for (const ref of joined.outputs) if (ref) results.push(await loadTaskData(ref, durable.read));
            applySourceFanout(cursor, joined, results, ref => enqueueSourceObject(cursor, ref));
          }
          const from = cursor.phase;
          result = await runSourceStep(cursor, io);
          const outputCount = outputs.length;
          const logStep = () =>
            logSourceStep(input, {
              runtime: 'node',
              kind: state.jobKind ?? null,
              from,
              to: fanout ? 'fanout' : result!.cursor.phase,
              objects: result!.metrics.objects,
              bytes: result!.metrics.bytes,
              outputs: outputCount,
              started,
            });
          const saved =
            result.cursor.phase === 'done'
              ? null
              : (await saveSourceProgress(result.cursor, progress, durable.store)).id;
          if (fanout) {
            const plan = fanout as SourceFanout;
            // The saved cursor refers to States this step already uploaded; the step
            // after the join resolves them, so they must be recorded before the fork.
            while (outputs.length)
              await ctx.runMutation(reference('projectConvexSourceStore:stage'), {
                ...input,
                objects: outputs.splice(0, 100),
              });
            await ctx.runMutation(reference('projectConvexSourceFanout:fork'), {
              ...input,
              cursor: saved,
              kind: plan.kind,
              end: plan.end,
              tasks: plan.tasks.map(task => JSON.stringify(task)),
            });
            logStep();
            return null;
          }
          await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
            ...input,
            cursor: saved,
            objects: outputs,
            output: result.cursor.output,
            failure: null,
          });
          logStep();
          return null;
        } catch (error) {
          // Platform failures stay retryable; a fenced step has nothing to settle.
          const domain = sourceDomainError(error);
          if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
          logSourceFailure(error, input, 'step', started);
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
        ctx.runMutation(reference('projectConvexSourceStore:failed'), {
          projectId: args.projectId,
          jobId: args.jobId,
          step: args.step,
          generation,
          cause,
        }),
    );
  },
});
