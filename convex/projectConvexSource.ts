// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { convexSourceTransport } from './projectConvexSourceTransport';
import { runSmallSourceCompose } from '../src/hosted-source-small-compose';
import { runSmallSourceSave } from '../src/hosted-source-small-save';
import { sourceDomainError } from './projectConvexSourceErrors';
import { logSourceFailure, logSourceStep, withSourceFailureLog } from '../src/hosted-source-io-error';
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
  let delegated = false,
    generation = input.generation ?? 0;
  return withSourceFailureLog(
    input,
    'small-save',
    async () => {
      const started = performance.now();
      const loaded: string | null = await ctx.runMutation(reference('projectConvexSourceStore:begin'), {
        ...input,
        ...(options.inline ? { inline: true } : {}),
      });
      if (!loaded) return null;
      const state = JSON.parse(loaded);
      generation = state.generation ?? generation;
      input = { ...input, generation };
      const transport = convexSourceTransport(ctx, input, state.locations, undefined, {
        overlapWrites: true,
        preloaded: options.preloaded,
        bindings: options.bindings,
        physicalManifests: state.physicalManifests === true,
        sourceKind: state.jobKind,
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
              preloaded: transport.preloaded(),
              ...(options.bindings ? { bindings: options.bindings } : {}),
              observedStates: transport.observedStates(),
            }),
            delegatedAt: Date.now(),
          });
        }
        await transport.settle();
        const outputCount = transport.outputs.length;
        const resultText = transport.smallOutput(output);
        const published: string | null = await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
          ...input,
          cursor: null,
          objects: transport.outputs,
          output,
          failure: null,
          stateSizes: transport.observedStates(),
          timing: { ...transport.clock.value(), phase: 'input>done', stop: 'done' },
          ...(resultText === null ? {} : { result: resultText }),
          ...(options.chain ? { chain: true } : {}),
        });
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
          outcome: 'failed',
          putBytes: transport.putMetrics.snapshot(),
        });
        const domain = sourceDomainError(error);
        if (!domain || domain.code === 'SOURCE_JOB_FENCED') throw error;
        logSourceFailure(error, input, 'small-save', started);
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
      delegated
        ? Promise.resolve()
        : ctx.runMutation(reference('projectConvexSourceStore:failed'), { ...input, generation, cause }),
  );
}
