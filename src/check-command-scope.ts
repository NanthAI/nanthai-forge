// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { contractTestPath } from './intent-test-contract.js';
import { scopedRecheckBase } from './scoped-recheck-policy.js';
import type { CheckGate } from './bet2-gate.js';
import { checkCallBudget, maxTestShards } from '../scripts/test-shards.mjs';

/** Selection contract for any configured check command (docs/workflows.md#check-command-scope).
 * Forge's own recipe (isStandardForgeCheck, src/standard-check.ts) selects and shards test files itself; every other command gets the
 * changed-paths file and, only when its check declares it, a reduced scope or shard parts. */
type Declaration = { scope?: 'changed-paths' | undefined; shards?: number | undefined } | undefined;
type Check = { executable: string; args: readonly string[]; selection?: Declaration };
type Run = {
  check: Check;
  gate?: CheckGate | undefined;
  candidate: { base: { head: string } };
  request: { expectedHead: string };
};

/** Changed paths are pinned in the plan (one request window); a larger list is left out
 * and the command runs in full. 128 KiB is about 3,000 typical paths. */
export const commandChangesBytes = 128 * 1024;

/** The file a command reads from `FORGE_CHECK_CHANGES`. `mode: "full"` means run everything. */
export type CommandChanges = {
  version: 1;
  comparison: 'main';
  base: string;
  head: string;
  mode: 'full' | 'scoped';
  paths?: string[];
  mainPaths?: string[];
  tests?: string[];
};
export type CommandSelection = {
  scope: 'full' | 'scoped';
  reason: string;
  tests: string[];
  changes: CommandChanges;
};

const fits = (paths: readonly string[]) =>
  new TextEncoder().encode(JSON.stringify(paths)).length <= commandChangesBytes;

/** A declared command may scope only where Forge's own check may (a contract, probe or scoped
 * gate); full and audit gates, and runs with no gate, always ask for everything. A scoped run
 * is scoped evidence (main-audit debt), never full, whatever the command then reports. */
export function commandSelection(
  run: Run,
  paths: readonly string[],
  files: { has(path: string): boolean },
  mainPaths: readonly string[] | null = null,
): CommandSelection {
  const changes = {
    version: 1 as const,
    comparison: 'main' as const,
    base: run.candidate.base.head,
    head: run.request.expectedHead,
    ...(fits(paths) ? { paths: [...paths].sort() } : {}),
  };
  const full = (reason: string): CommandSelection => ({
    scope: 'full',
    reason,
    tests: [],
    changes: { ...changes, mode: 'full' },
  });
  const gate = run.gate;
  if (run.check.selection?.scope !== 'changed-paths') return full('Exact configured command');
  if (!changes.paths)
    return full(`Command scope: ${paths.length} changed paths exceed the changed-paths file; full run`);
  if (!gate || gate.mode === 'full' || gate.mode === 'audit')
    return full(`Command scope: ${gate ? `${gate.mode} gate` : 'no reduced-evidence gate'}; full run`);
  if (scopedRecheckBase(gate)) {
    if (!mainPaths || !fits(mainPaths))
      return full('Command scope: scoped recheck base unavailable; full run');
    return {
      scope: 'scoped',
      reason: 'Command scope: scoped recheck, command-selected',
      tests: [],
      changes: { ...changes, mode: 'scoped', mainPaths: [...mainPaths].sort() },
    };
  }
  const tests = [...new Set(gate.tests ?? [])].sort();
  invariant(
    tests.every(test => contractTestPath.safeParse(test).success && files.has(test)),
    'EVIDENCE_CHANGED',
    'A gate test is absent from the exact Candidate.',
  );
  return {
    scope: 'scoped',
    reason: `Command scope: ${gate.reason ?? `${gate.mode} gate`}, command-selected`,
    tests,
    changes: { ...changes, mode: 'scoped', ...(tests.length ? { tests } : {}) },
  };
}

/** Plan groups for a command's shard interface: one marker per job, never a test file path. */
export const commandShardGroups = (count: number) =>
  Array.from({ length: count }, (_, index) => [`forge-command-shard:${index + 1}/${count}`]);

/** The declared count within the same job and Convex call budget as Forge's own shards. */
export function commandShardCount(
  check: Check,
  {
    concurrencyBudget = 12,
    callsPerJob,
    jobCap,
  }: { concurrencyBudget?: number; callsPerJob: number; jobCap?: number | undefined },
) {
  const declared = check.selection?.shards;
  if (!declared) return 0;
  const count = Math.min(
    declared,
    concurrencyBudget - 1,
    Math.floor(checkCallBudget / callsPerJob) - 1,
    maxTestShards,
    jobCap === undefined ? Infinity : jobCap - 2,
  );
  return count >= 2 ? count : 0;
}

/** Server check of an opaque command's plan: scope, gate tests, changes pins and shard markers. */
export function validCommandPlan(
  run: Run,
  recipe: {
    selection: { scope: string; tests: readonly string[]; changes?: unknown };
    groups: string[][];
    pool?: unknown;
  },
) {
  const { selection, groups } = recipe;
  const declared = run.check.selection;
  const changes = selection.changes as Partial<CommandChanges> | undefined;
  const scoped = selection.scope === 'scoped';
  return (
    recipe.pool === undefined &&
    (groups.length === 0 ||
      (groups.length >= 2 &&
        groups.length <= (declared?.shards ?? 0) &&
        JSON.stringify(groups) === JSON.stringify(commandShardGroups(groups.length)))) &&
    (selection.scope === 'full' ||
      // A docs scope runs no command; its own rule (the check's docs paths) is checked beside this.
      (selection.scope === 'docs' && groups.length === 0 && changes === undefined) ||
      (scoped &&
        declared?.scope === 'changed-paths' &&
        !!run.gate &&
        !['full', 'audit'].includes(run.gate.mode) &&
        (run.gate.tests ?? []).every(test => selection.tests.includes(test)))) &&
    // Older planners send no changes file; when present it must name this exact Candidate.
    (changes === undefined ||
      (changes.version === 1 &&
        changes.base === run.candidate.base.head &&
        changes.head === run.request.expectedHead &&
        changes.mode === (scoped ? 'scoped' : 'full')))
  );
}
