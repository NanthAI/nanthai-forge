// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { trialReader } from './projectHostedConflictRead';
import { trialMerge } from '../src/hosted-trial-merge';
import { mergePathsOf } from '../src/native-docs-resolve';
import { FORGE_CONFIG_FILE, type DeclaredMergePaths } from '../src/project-config';
import { type TrialObject, type TrialPlan } from '../src/hosted-trial-plan';

const mainStateOf = (ctx: ActionCtx, projectId: Id<'hostedProjects'>) =>
  ctx.runQuery(
    makeFunctionReference<
      'query',
      { projectId: Id<'hostedProjects'> },
      { head: string; state: TrialObject } | null
    >('projectHostedConflicts:mainState'),
    { projectId },
  );
/** Warm action processes keep the last main head's merge lists: main moves a few times an hour, so
 * most conflicts reuse them without re-reading main's State (megabytes at dogfood scale). */
let lastLists: { projectId: string; head: string; declared: DeclaredMergePaths } | undefined;
/** Main's forge.json merge lists, as compose reads them (from main only): from main's State the
 * caller already parsed, else main's current head State. None when absent or unreadable. */
async function mainMergeLists(ctx: ActionCtx, projectId: Id<'hostedProjects'>): Promise<DeclaredMergePaths> {
  const main = await mainStateOf(ctx, projectId).catch(() => null);
  if (!main) return mergePathsOf(undefined);
  const head = main.head;
  if (lastLists?.projectId === projectId && lastLists.head === head) return lastLists.declared;
  const reader = trialReader(ctx, projectId, { laneId: '', head, peers: [], tasks: [], objects: [] });
  const files = await reader.state(main.state).catch(() => null);
  if (!files) return mergePathsOf(undefined);
  const config = files.get(FORGE_CONFIG_FILE);
  const bytes = config?.mode === 'file' ? await reader.blob(config.blob).catch(() => undefined) : undefined;
  const declared = mergePathsOf(bytes);
  // A forge.json that could not be read is not remembered as "no lists".
  if (config?.mode !== 'file' || bytes) lastLists = { projectId, head, declared };
  return declared;
}

/** The would-conflict pass's one read of main's forge.json (a mutation cannot read R2): main's State,
 * then forge.json, then the pass again with `declared`. On any failure the pass runs with none, as
 * before (path advice only). Runs only when a landing would mark a queued entry. */
export const wouldConflictConfig = internalAction({
  args: { projectId: v.id('hostedProjects'), paths: v.array(v.string()), landedSubmissionId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const declared = await mainMergeLists(ctx, input.projectId);
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingWouldConflict:mark'), {
      ...input,
      declared,
    });
    return null;
  },
});

/** One save's trial merge (flip 4, Issue 853fcde3): reads the planned objects from R2, merges with
 * composition's rules and records the result in one mutation. Advisory: a failure is logged and
 * leaves no notice; the landing's own composition still decides. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), plan: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, plan: text }) => {
    const started = performance.now();
    const plan = JSON.parse(text) as TrialPlan;
    const reader = trialReader(ctx, projectId, plan);
    let found: Awaited<ReturnType<typeof trialMerge>>['conflicts'] = [];
    try {
      const files = await reader.prepare();
      const declared = async () => {
        if (!files) return mainMergeLists(ctx, projectId);
        const config = files.get(FORGE_CONFIG_FILE);
        return mergePathsOf(
          config?.mode === 'file' ? await reader.blob(config.blob).catch(() => undefined) : undefined,
        );
      };
      const result = await trialMerge(plan.tasks, reader.read, declared);
      found = result.conflicts;
      console.log(
        `FORGE_TRIAL_MERGE ${JSON.stringify({
          lane: plan.laneId.slice(0, 8),
          files: plan.tasks.length,
          peers: plan.peers.length,
          merges: result.merges,
          conflicts: result.conflicts.length,
          unavailable: result.unavailable.length,
          bytes: reader.bytes,
          ms: Math.round(performance.now() - started),
        })}`,
      );
    } catch (error) {
      console.log(
        `FORGE_TRIAL_MERGE_FAILED ${JSON.stringify({
          lane: plan.laneId.slice(0, 8),
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        })}`,
      );
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedConflicts:record'), {
      projectId,
      laneId: plan.laneId,
      head: plan.head,
      peers: plan.peers,
      ...(plan.main ? { mainHead: plan.main.head } : {}),
      conflicts: found,
    });
    return null;
  },
});
