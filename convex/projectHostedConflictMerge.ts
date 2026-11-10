// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import type { ObjectView } from './projectObjectFind';
import { rawContent } from './projectObjectContent';
import { r2Config, presignGet, r2Key } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { digest } from '../src/hash';
import { parseNativeState } from '../src/native-state-format';
import { trialMerge, TrialUnavailable } from '../src/hosted-trial-merge';
import { TRIAL_FILE_BYTES, type TrialObject, type TrialPlan } from '../src/hosted-trial-plan';

/** A main blob the planning write could not resolve (main changed after it read): raw R2 bytes by
 * digest, verified, at most TRIAL_FILE_BYTES. Anything else is unavailable, never guessed. */
async function mainBlob(projectId: string, blob: string) {
  const url = await presignGet(r2Config(), r2Key(projectId, blob));
  const response = await exchangeFetch('trial merge main blob', url, {
    headers: { 'accept-encoding': 'identity' },
  });
  if (!response.ok) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length <= TRIAL_FILE_BYTES && digest(bytes) === blob ? bytes : undefined;
}

/** One save's trial merge (flip 4, Issue 853fcde3): reads the planned objects from R2, merges with
 * composition's rules and records the result in one mutation. Advisory: a failure is logged and
 * leaves no notice; the landing's own composition still decides. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects'), plan: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, plan: text }) => {
    const started = performance.now();
    const plan = JSON.parse(text) as TrialPlan;
    const held = new Map<string, Buffer>();
    let bytes = 0;
    const load = async (object: TrialObject) => {
      try {
        const value = await rawContent(ctx, object as unknown as ObjectView, {
          sha256: object.digest,
          size: object.size,
        });
        held.set(object.digest, value);
        bytes += value.length;
      } catch {
        /* Unavailable: the tasks that need it are skipped. */
      }
    };
    try {
      const reads = [...plan.objects];
      if (plan.main) reads.push(plan.main.state);
      for (let i = 0; i < reads.length; i += 8) await Promise.all(reads.slice(i, i + 8).map(load));
      if (plan.main) {
        const state = held.get(plan.main.state.digest);
        held.delete(plan.main.state.digest);
        const files = state ? new Map(parseNativeState(state).files.map(file => [file.path, file])) : null;
        for (const task of plan.tasks) {
          if (!files || !plan.main.paths.includes(task.path)) continue;
          const file = files.get(task.path);
          task.main = file ? { blob: file.blob, mode: file.mode } : null;
          if (file && !held.has(file.blob) && file.mode !== 'symlink' && file.mode !== 'gitlink') {
            const value = await mainBlob(projectId, file.blob).catch(() => undefined);
            if (value) {
              held.set(file.blob, value);
              bytes += value.length;
            }
          }
        }
      }
      const result = await trialMerge(plan.tasks, blob => {
        const value = held.get(blob);
        if (!value) throw new TrialUnavailable(blob);
        return value;
      });
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedConflicts:record'), {
        projectId,
        laneId: plan.laneId,
        head: plan.head,
        peers: plan.peers,
        ...(plan.main ? { mainHead: plan.main.head } : {}),
        conflicts: result.conflicts,
      });
      console.log(
        `FORGE_TRIAL_MERGE ${JSON.stringify({
          lane: plan.laneId.slice(0, 8),
          files: plan.tasks.length,
          peers: plan.peers.length,
          merges: result.merges,
          conflicts: result.conflicts.length,
          unavailable: result.unavailable.length,
          bytes,
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
    return null;
  },
});
