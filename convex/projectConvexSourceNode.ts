// SPDX-License-Identifier: Apache-2.0
'use node';
import { runPhysicalSeedStep } from './projectPhysicalSeedStep';
import { takeSourceOutputs } from './projectConvexSourceOutputPages';
import { v } from 'convex/values';
import { digest as nativeDigest } from '../src/hash';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { runPreparedResolveChain } from './projectHostedResolveChainRun';
import type { InlinePublication } from './projectSourcePublishInline';
import { MemoryMergeSource } from '../src/hosted-source-memory';
import { saveInputSchema } from '../src/hosted-save';
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
  handler: (ctx, args) => runNodeSourceStep(ctx, args),
});
/** Direct chained execution stays in the same Node action. Every job still begins
 * under its own current authority fence; only immutable verified source is shared. */
async function runNodeSourceStep(
  ctx: ActionCtx,
  args: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    step: number;
    generation?: number;
    loaded?: string;
    delegatedAt?: number;
  },
  options: {
    retained?: MemoryMergeSource;
    inline?: boolean;
    preloaded?: { sha256: string; size: number; text: string }[];
  } = {},
): Promise<string | null> {
  const entered = performance.now();
  let generation = args.generation ?? 0,
    retained = options.retained;
  const published = await withSourceFailureLog(
    args,
    'step',
    async () => {
      const started = performance.now();
      const { loaded: supplied, delegatedAt, ...input } = args;
      const loaded: string | null =
        supplied ??
        (await ctx.runMutation(reference('projectConvexSourceStore:begin'), {
          ...input,
          ...(options.inline ? { inline: true } : {}),
        }));
      if (!loaded) return null;
      const state = JSON.parse(loaded);
      const chain = state.jobKind === 'save' && state.chain === true;
      if (chain) retained = retainedSave(state);
      generation = state.generation ?? generation;
      input.generation = generation;
      if (state.physicalSeed) {
        try {
          return await runPhysicalSeedStep(ctx, input, state);
        } catch (error) {
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
      }
      const { io, outputs, settle, clock, smallOutput, putMetrics, observedStates } = convexSourceTransport(
          ctx,
          input,
          state.locations,
          supplied ? delegatedAt : undefined,
          // Texts the delegating action holds come only through `loaded` (never from a schedule).
          {
            overlapWrites: true,
            hash: nativeDigest,
            preloaded: options.preloaded ?? (supplied ? state.preloaded : undefined),
            physicalManifests: state.physicalManifests === true,
            sourceKind: state.jobKind,
            bindings: supplied ? state.bindings : undefined,
            observed: supplied ? state.observedStates : undefined,
          },
        ),
        durable = sourceStorage(ctx, input.projectId, nativeDigest, putMetrics.observer('progress'));
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
            joined.failureReason ?? 'A bounded source step failed.',
          );
          const results: SourceTaskProgress[] = [];
          for (const ref of joined.outputs) if (ref) results.push(await loadTaskData(ref, durable.read));
          applySourceFanout(cursor, joined, results, ref => enqueueSourceObject(cursor, ref));
        }
        const from = cursor.phase;
        // Consecutive quanta share descriptors and verified bytes, then commit once. Each
        // quantum still drops its parsed merge heap; fan-out remains a durable boundary.
        const cached = retained ? io : cachedReads(io, { bytes: new Map(), held: 0 }, 8 * 1024 * 1024);
        let objects = 0,
          bytes = 0;
        for (let quantum = 0; quantum < 4; quantum++) {
          result = await runSourceStep(cursor, cached, retained);
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
            putBytes: putMetrics.snapshot(result!.cursor.output),
            started,
          });
        if (fanout) {
          const plan = fanout as SourceFanout;
          // The saved cursor refers to States this step already uploaded; the step
          // after the join resolves them, so they must be recorded before the fork.
          while (outputs.length) {
            const objects = takeSourceOutputs(outputs);
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
            stateSizes: observedStates(),
          });
          logStep();
          return null;
        }
        for (;;) {
          const objects = takeSourceOutputs(outputs, true);
          if (!objects.length) break;
          await clock.call(() =>
            ctx.runMutation(reference('projectConvexSourceStore:stage'), { ...input, objects }),
          );
        }
        const resultText = smallOutput(result.cursor.output);
        const published: string | null = await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
          ...input,
          cursor: saved,
          objects: outputs,
          output: result.cursor.output,
          failure: null,
          ...(chain ? { chain: true } : {}),
          stateSizes: observedStates(),
          timing: { ...clock.value(), ...result.metrics.detail },
          ...(resultText === null ? {} : { result: resultText }),
        });
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
          ...(domain.code === 'SOURCE_STATE_TOO_LARGE' ? { failureReason: domain.message } : {}),
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
  if (!published || !retained) return published;
  const publication = JSON.parse(published) as InlinePublication;
  retained.committedInputs();
  // Same 16 MiB retained-input allowance as inline calculation re-entry.
  // Larger saves release this action before the existing chain runs elsewhere.
  if (
    !publication.chainRun ||
    retained.inputBytes() > 16 * 1024 * 1024 ||
    performance.now() - entered >= 20000
  )
    return published;
  const memory = retained;
  const chainResult = await runPreparedResolveChain(ctx, publication.chainRun, (input, preloaded) =>
    runNodeSourceStep(ctx, input, { retained: memory, inline: true, preloaded: [preloaded] }),
  );
  return JSON.stringify({ ...publication, chainResult });
}

/** Route only a verified small plan whose baseline plus largest possible delta
 * and saved State fit the existing retained-input allowance. No larger save
 * retains its raw baseline across publication merely to discover that it cannot
 * share it. Unknown/continued shapes keep the ordinary independent chain. */
function retainedSave(state: {
  input: { sha256: string; size: number };
  preloaded?: { sha256: string; size: number; text: string }[];
}) {
  const value = state.preloaded?.find(
    value => value.sha256 === state.input.sha256 && value.size === state.input.size,
  );
  if (!value) return undefined;
  const bytes = Buffer.from(value.text);
  if (bytes.length !== state.input.size || nativeDigest(bytes) !== state.input.sha256) return undefined;
  try {
    const plan = saveInputSchema.parse(JSON.parse(value.text));
    return plan.pageCount === 1 &&
      2 * plan.baseline.object.size + plan.pages.size + 2 * bytes.length + 64 * 1024 <= 16 * 1024 * 1024
      ? new MemoryMergeSource({})
      : undefined;
  } catch {
    return undefined;
  }
}
