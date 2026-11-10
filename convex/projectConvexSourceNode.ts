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
import { cachedReads } from '../src/hosted-source-read-cache';
import { invariant } from '../src/errors';
import { sourceDomainError } from './projectConvexSourceErrors';
import { logSourceFailure, logSourceStep, withSourceFailureLog } from '../src/hosted-source-io-error';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string() };
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
export const step = internalAction({
  args: {
    ...identity,
    step: v.number(),
    generation: v.optional(v.number()),
    loaded: v.optional(v.string()),
    delegatedAt: v.optional(v.number()),
  },
  /** The publication its terminal commit made for a small result (see projectSourcePublishInline). */
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    let generation = args.generation ?? 0;
    return withSourceFailureLog(
      args,
      'step',
      async () => {
        const started = performance.now();
        const { loaded: supplied, delegatedAt, ...input } = args;
        const loaded: string | null =
          supplied ?? (await ctx.runMutation(reference('projectConvexSourceStore:begin'), input));
        if (!loaded) return null;
        const state = JSON.parse(loaded);
        generation = state.generation ?? generation;
        input.generation = generation;
        const { io, outputs, settle, clock, smallOutput } = convexSourceTransport(
            ctx,
            input,
            state.locations,
            supplied ? delegatedAt : undefined,
            // Texts the delegating action holds come only through `loaded` (never from a schedule).
            {
              overlapWrites: true,
              preloaded: supplied ? state.preloaded : undefined,
            },
          ),
          durable = sourceStorage(ctx, input.projectId);
        let cursor: SourceStepCursor = initialSourceStep(state.input),
          progress: SourceProgress | null = null;
        let result!: Awaited<ReturnType<typeof runSourceStep>>;
        let fanout: SourceFanout | null = null;
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
              await clock.call(() => ctx.runMutation(reference('projectConvexSourceFanout:results'), input)),
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
          // Consecutive quanta share descriptors and verified bytes, then commit once. Each
          // quantum still drops its parsed merge heap; fan-out remains a durable boundary.
          const cached = cachedReads(io, { bytes: new Map(), held: 0 }, 8 * 1024 * 1024);
          let objects = 0,
            bytes = 0;
          for (let quantum = 0; quantum < 4; quantum++) {
            result = await runSourceStep(cursor, cached);
            objects += result.metrics.objects;
            bytes += result.metrics.bytes;
            cursor = result.cursor;
            await settle();
            if (
              cursor.phase === 'done' ||
              fanout ||
              quantum === 3 ||
              performance.now() - started >= 20000 ||
              bytes >= 8 * 1024 * 1024 ||
              outputs.length >= 100
            )
              break;
          }
          result!.metrics.objects = objects;
          result!.metrics.bytes = bytes;
          result!.metrics.detail.phase = `${from}>${cursor.phase}`;
          // The cursor write overlaps the step's last output writes; both finish before staging.
          const [saved] = await Promise.all([
            result.cursor.phase === 'done'
              ? null
              : saveSourceProgress(result.cursor, progress, durable.store).then(saved => saved.id),
            settle(),
          ]);
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
          if (fanout) {
            const plan = fanout as SourceFanout;
            // The saved cursor refers to States this step already uploaded; the step
            // after the join resolves them, so they must be recorded before the fork.
            while (outputs.length) {
              const objects = outputs.splice(0, 100);
              await clock.call(() =>
                ctx.runMutation(reference('projectConvexSourceStore:stage'), { ...input, objects }),
              );
            }
            await ctx.runMutation(reference('projectConvexSourceFanout:fork'), {
              ...input,
              cursor: saved,
              kind: plan.kind,
              end: plan.end,
              tasks: plan.tasks.map(task => JSON.stringify(task)),
              timing: { ...clock.value(), ...result.metrics.detail },
            });
            logStep();
            return null;
          }
          while (outputs.length > 100) {
            const objects = outputs.splice(0, 100);
            await clock.call(() =>
              ctx.runMutation(reference('projectConvexSourceStore:stage'), { ...input, objects }),
            );
          }
          const resultText = smallOutput(result.cursor.output);
          const published: string | null = await ctx.runMutation(
            reference('projectConvexSourceStore:commit'),
            {
              ...input,
              cursor: saved,
              objects: outputs,
              output: result.cursor.output,
              failure: null,
              timing: { ...clock.value(), ...result.metrics.detail },
              ...(resultText === null ? {} : { result: resultText }),
            },
          );
          logStep();
          // A sync the step published also hands its submitter the result as changes from the
          // client's Lane head (one-trip sync): in this reply only, never stored.
          const delta = result.cursor.syncDelta;
          return published && delta ? JSON.stringify({ ...JSON.parse(published), delta }) : published;
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
