// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { isStandardForgeCheck } from './standard-check.js';
import { contractTestPath } from './intent-test-contract.js';
import { scopedRecheckBase, scopedRecheckPairs } from './scoped-recheck-policy.js';
import type { CheckGate } from './bet2-gate.js';
import { checkCallBudget, maxTestShards } from '../scripts/test-shards.mjs';
import { GRAPH_FIRST_MAX_SHARE, isGraphFirstGate, type GraphShare } from './graph-first-check.js';

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
  /** A cohort recheck (Issue 28f08555): per member basis, its checked change and the other side. */
  members?: { paths: string[]; mainPaths: string[] }[];
  tests?: string[];
};
export type CommandSelection = {
  scope: 'full' | 'scoped';
  reason: string;
  tests: string[];
  changes: CommandChanges;
  /** A package-graph-scoped first check's share (src/graph-first-check.ts), recorded on the run. */
  graph?: GraphShare;
};

const fits = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= commandChangesBytes;

/** A declared command may scope only where Forge's own check may (a contract, probe or scoped
 * gate); full and audit gates, and runs with no gate, always ask for everything. A scoped run
 * is scoped evidence (main-audit debt), never full, whatever the command then reports.
 * A package-graph first check (`graph-first` gate) scopes only when `share` (the minority rule
 * over this Candidate's manifests) says so. */
export function commandSelection(
  run: Run,
  paths: readonly string[],
  files: { has(path: string): boolean },
  mainPaths: readonly string[] | null = null,
  share?: (paths: string[]) => GraphShare,
  members: readonly { lanePaths: readonly string[]; mainPaths: readonly string[] }[] | null = null,
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
  if (scopedRecheckPairs(gate)) {
    const sides = members?.map(member => ({
      paths: [...member.lanePaths].sort(),
      mainPaths: [...member.mainPaths].sort(),
    }));
    if (!sides || !fits(sides))
      return full('Command scope: scoped cohort recheck bases unavailable; full run');
    return {
      scope: 'scoped',
      reason: 'Command scope: scoped cohort recheck, command-selected',
      tests: [],
      changes: { ...changes, mode: 'scoped', members: sides },
    };
  }
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
  if (isGraphFirstGate(gate)) {
    const graph = share ? share([...paths]) : null;
    if (!graph) return full('Command scope: package graph unavailable to this planner; full run');
    if (graph.scope === 'full') return { ...full(`Command scope: ${graph.reason}; full run`), graph };
    return {
      scope: 'scoped',
      reason: `Command scope: package-graph first check, ${graph.reason}, command-selected`,
      tests: [],
      changes: { ...changes, mode: 'scoped' },
      graph,
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

/** The one line a repository's CI script adds at its test step to run only the affected packages. */
export const PACKAGES_RUN_LINE = '[ -z "${FORGE_CHECK_PACKAGES_RUN:-}" ] || exec "$FORGE_CHECK_PACKAGES_RUN"';
/** What configure-check and check-settings propose for a configured command that declares no scope:
 * it then runs in full on every check, so the package graph never saves a check minute. */
export function commandScopeProposal(check: {
  name?: string;
  executable: string;
  args: readonly string[];
  selection?: Declaration;
}) {
  if (isStandardForgeCheck(check) || check.selection?.scope) return null;
  return {
    check: check.name ?? null,
    selection: { scope: 'changed-paths' as const },
    line: PACKAGES_RUN_LINE,
    detail:
      'This command runs in full on every check. Declare selection:{scope:"changed-paths"} (configure-check command) and add the line at its test step, after setup: scoped checks then run only the affected packages with each ecosystem\'s own test command (docs/workflows.md#check-command-scope).',
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

/** A graph-first scoped plan names its share and it is a minority (the planner's rule, re-checked). */
const graphMinority = (graph: unknown) => {
  const share = graph as Partial<GraphShare> | undefined;
  return (
    share?.scope === 'scoped' &&
    Number.isSafeInteger(share.selected) &&
    Number.isSafeInteger(share.total) &&
    share.selected! >= 1 &&
    share.selected! <= share.total! * GRAPH_FIRST_MAX_SHARE
  );
};

/** Server check of an opaque command's plan: scope, gate tests, changes pins and shard markers. */
export function validCommandPlan(
  run: Run,
  recipe: {
    selection: { scope: string; tests: readonly string[]; changes?: unknown; graph?: unknown };
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
        (run.gate.tests ?? []).every(test => selection.tests.includes(test)) &&
        (!isGraphFirstGate(run.gate) || graphMinority(selection.graph)))) &&
    // Older planners send no changes file; when present it must name this exact Candidate.
    (changes === undefined ||
      (changes.version === 1 &&
        changes.base === run.candidate.base.head &&
        changes.head === run.request.expectedHead &&
        changes.mode === (scoped ? 'scoped' : 'full')))
  );
}
