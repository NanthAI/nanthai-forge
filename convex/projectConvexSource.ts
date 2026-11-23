// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { takeSourceOutputs } from './projectConvexSourceOutputPages';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexSourceTransport } from './projectConvexSourceTransport';
import { runSmallSourceCompose } from '../src/hosted-source-small-compose';
import { runSmallSourceSave } from '../src/hosted-source-small-save';
import { sourceDomainError } from './projectConvexSourceErrors';
import {
  logSourceFailure,
  logSourceStep,
  sourceFailureCause,
  withSourceFailureLog,
} from '../src/hosted-source-io-error';
import { sourceStepClock } from '../src/source-step-clock';
import { keepSourceLease } from '../src/hosted-source-lease';
export { dispatch } from './projectConvexSourceStore';
export { convexSourceTransport } from './projectConvexSourceTransport';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** Small saves and metadata-only compositions avoid Node cold starts. Other work retains the bounded,
 * resumable Node implementation and the begin/commit authority fence. */
export const step = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    jobId: v.string(),
    step: v.number(),
    generation: v.optional(v.number()),
    /** Run as the submitting action's own first step (its fallback stays pending); the submit-run
     * action calls `runConvexSourceStep` directly, so only a harness names this. */
    inline: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { inline, ...input }) => {
    await runConvexSourceStep(ctx, input, inline ? { inline } : {});
    return null;
  },
});
/** What an action that submitted the job (and so ran its first step itself) already holds. */
export type InlineStepOptions = {
  /** This is the submitting action's own run: `begin` never defers it as a fallback (R1). */
  inline?: boolean;
  /** The committing action runs a published save's resolve chain itself. */
  chain?: boolean;
  /** Objects this action just committed after a HEAD confirmed their exact size and checksum
   * (`commitObjects`). A small save does not download them again only to re-hash them. */
  verified?: readonly { sha256: string; size: number }[];
  /** Bindings this action just committed and checksum/member-verified, in the same project. */
  bindings?: readonly {
    sha256: string;
    size: number;
    r2Key: string;
    pack?: import('../src/object-pack-range').ObjectPack;
  }[];
  /** Exact small texts this action holds (the job input it just wrote, or the one its caller sent);
   * the step reads them from memory after the same digest check a download gets. */
  preloaded?: readonly { sha256: string; size: number; text: string }[];
};
/** One step of the execution: the scheduled `step`, or the first step run by the action that submitted
 * the job (no scheduler wait; its delayed fallback covers that action dying). Returns the publication
 * when the step finished the job and published its small result in its own commit. */
export async function runConvexSourceStep(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; jobId: string; step: number; generation?: number },
  options: InlineStepOptions = {},
): Promise<string | null> {
  const clock = sourceStepClock();
  let delegated = false,
    generation = input.generation ?? 0;
  return withSourceFailureLog(
    input,
    'small-save',
    async () => {
      const started = performance.now();
      const loaded: string | null = await clock.startup(() =>
        ctx.runMutation(reference('projectConvexSourceStore:begin'), {
          ...input,
          ...(options.inline ? { inline: true } : {}),
        }),
      );
      if (!loaded) return null;
      const state = JSON.parse(loaded);
      clock.dispatchedAt(state.scheduledAt);
      generation = state.generation ?? generation;
      input = { ...input, generation };
      // Also covers a step delegated to the Node runtime: this action awaits it.
      const stopLease = keepSourceLease(() => {
        const phase = delegated ? undefined : clock.slowPhase();
        return ctx.runMutation(reference('projectConvexSourceLease:renew'), {
          projectId: input.projectId,
          jobId: input.jobId,
          step: input.step,
          generation,
          ...(phase ? { phase } : {}),
        });
      }, state.lease);
      try {
        const transport = convexSourceTransport(ctx, input, state.locations, undefined, {
          overlapWrites: true,
          clock,
          preloaded: options.preloaded,
          bindings: options.bindings,
          physicalManifests: state.physicalManifests === true,
          sourceKind: state.jobKind,
        });
        let output: Awaited<ReturnType<typeof runSmallSourceSave>> = null;
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
              options.verified,
            );
          else if (state.jobKind === 'compose' && !state.cursor && !state.batchId)
            output = await runSmallSourceCompose(state.input, transport.io);
          if (!output) {
            // Reuse the already-authorized begin and bounded descriptors on fallback.
            delegated = true;
            await transport.settle();
            return await ctx.runAction(makeFunctionReference<'action'>('projectConvexSourceNode:step'), {
              ...input,
              loaded: JSON.stringify({
                ...state,
                locations: [...transport.locations.values()],
                preludeTiming: clock.summary(),
                preloaded: transport.preloaded(),
                ...(options.bindings ? { bindings: options.bindings } : {}),
                observedStates: transport.observedStates(),
                ...(options.chain ? { chain: true } : {}),
              }),
              delegatedAt: Date.now(),
            });
          }
          await transport.settle();
          const outputCount = transport.outputs.length;
          for (;;) {
            const objects = takeSourceOutputs(transport.outputs, true);
            if (!objects.length) break;
            await transport.clock.call(() =>
              ctx.runMutation(reference('projectConvexSourceStore:stage'), { ...input, objects }),
            );
          }
          const outputPin = output;
          const resultText = transport.smallOutput(outputPin);
          const timing = { ...clock.value(), summary: clock.summary(), phase: 'input>done', stop: 'done' };
          const published: string | null = await clock.call<string | null>(() =>
            ctx.runMutation(reference('projectConvexSourceStore:commit'), {
              ...input,
              cursor: null,
              objects: transport.outputs,
              output: outputPin,
              failure: null,
              stateSizes: transport.observedStates(),
              timing,
              ...(resultText === null ? {} : { result: resultText }),
              ...(options.chain ? { chain: true } : {}),
            }),
          );
          logSourceStep(input, {
            runtime: 'v8',
            kind: state.jobKind ?? null,
            from: 'input',
            to: 'done',
            objects: transport.reads.objects,
            bytes: transport.reads.bytes,
            outputs: outputCount,
            putBytes: transport.putMetrics.snapshot(output),
            started,
            timing: clock.summary(),
          });
          return published;
        } catch (error) {
          if (delegated) throw error;
          logSourceStep(input, {
            runtime: 'v8',
            kind: state.jobKind ?? null,
            from: 'input',
            to: null,
            objects: transport.reads.objects,
            bytes: transport.reads.bytes,
            outputs: transport.outputs.length,
            started,
            timing: clock.summary(),
            outcome: 'failed',
            putBytes: transport.putMetrics.snapshot(),
          });
          const domain = sourceDomainError(error);
          if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
          const timing = clock.summary();
          logSourceFailure(error, input, 'small-save', started, timing);
          await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
            ...input,
            cursor: state.cursor,
            objects: [],
            output: null,
            failure: domain.code,
            cause: sourceFailureCause(error, 'small-save', started, timing),
            timing: clock.value(),
            ...(domain.code === 'SOURCE_STATE_TOO_LARGE' ? { failureReason: domain.message } : {}),
          });
          return null;
        }
      } finally {
        await stopLease();
      }
    },
    cause =>
      delegated
        ? Promise.resolve()
        : ctx.runMutation(reference('projectConvexSourceStore:failed'), { ...input, generation, cause }),
    () => (delegated ? undefined : clock.summary()),
  );
}
