// SPDX-License-Identifier: Apache-2.0
import type { HostedDepsCache, HostedToolchains } from './actions-toolchains-hosted.js';

/** Where the planning step leaves its read of the runner's queue (written by `capacity`). */
export const actionsCapacityFile = 'forge-actions-capacity.json';

/**
 * Plan and run in one process (Issue ca8a2ca4): one supervisor start, one session, no second
 * step. Only a workflow that opts in (FORGE_ACTIONS_FOLD=1) gets it, and only when nothing must
 * run between planning and execution:
 * - a single static execution (no test shards to distribute);
 * - no source-pack refresh: that job reads this Candidate directory, which must not hold
 *   anything project code wrote;
 * - no declared toolchain or dependency-cache step (those run between plan and run);
 * - Forge's npm download cache is already restored when the check is Forge's own suite;
 * - no GitHub token in this process: the folded step runs project code, which must never see it.
 * Anything else keeps the separate run step, exactly as before.
 */
export function actionsFoldDecision(input: {
  env: Record<string, string | undefined>;
  singleShard: string;
  toolchains: HostedToolchains;
  depsCache: HostedDepsCache;
  npmCache: boolean;
  packRefresh: boolean;
}): { fold: true } | { fold: false; reason: string } {
  const { env } = input;
  if (env.FORGE_ACTIONS_FOLD !== '1') return { fold: false, reason: 'workflow did not opt in' };
  if (env.GITHUB_TOKEN) return { fold: false, reason: 'a GitHub token is in the planning environment' };
  if (input.singleShard !== 'static') return { fold: false, reason: 'test shards run in their own jobs' };
  if (input.packRefresh) return { fold: false, reason: 'the source pack refresh reads this Candidate' };
  if (Object.keys(input.toolchains).length || Object.keys(input.depsCache).length)
    return { fold: false, reason: 'declared setup steps run between plan and run' };
  if (input.npmCache && env.FORGE_ACTIONS_NPM_CACHE !== 'ready')
    return { fold: false, reason: 'the npm download cache is restored after planning' };
  return { fold: true };
}

/** A capacity file written by the `capacity` step; anything unreadable means no observation. */
export function parseActionsCapacity(text: string | undefined) {
  try {
    const value = JSON.parse(text ?? 'null') as { activeChecks?: unknown; jobCap?: unknown } | null;
    return value &&
      Number.isSafeInteger(value.activeChecks) &&
      Number.isSafeInteger(value.jobCap) &&
      (value.activeChecks as number) >= 0 &&
      (value.jobCap as number) > 0
      ? { activeChecks: value.activeChecks as number, jobCap: value.jobCap as number }
      : undefined;
  } catch {
    return undefined;
  }
}
