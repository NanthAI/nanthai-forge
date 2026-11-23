// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { CoverageInput, CoverageShadow } from './test-coverage.mjs';
export type SelectionReason = {
  kind: string;
  changedPath?: string;
  chain?: string[];
  edges?: string[];
  detail?: string;
};
export type TestSelection = {
  scope: string;
  reason: string;
  tests: string[];
  affectedTests?: string[];
  reasons?: Record<string, SelectionReason>;
  coverage?: CoverageShadow;
};
/** Installed selector contract used by native runner queue admission. */
export function standardSelection(input: {
  files: Map<string, string>;
  coverage?: CoverageInput | undefined;
  paths?: string[];
  semanticTests?: string[];
  interaction?: unknown;
  mainCheck?: unknown;
  env?: Record<string, string | undefined>;
  /** Caller-owned graph for this immutable inventory and comparison. */
  graphCache?: object;
}): TestSelection;

/** Fail-closed wrapper used by every planner: a non-docs selection always has tests. */
export function guardedSelection<T extends { scope: string; reason: string; tests: string[] }>(
  selection: T,
  input: { files: Map<string, string>; paths?: string[] | null | undefined; interaction?: unknown },
): T;

/** Read-only variant for reports: a source with no test file yields an empty selection with the reason. */
export function advisorySelection(input: Parameters<typeof standardSelection>[0]): TestSelection;

export function selectionSourcePath(path: string): boolean;

/** `graphCache`: a caller-owned `{}` shared by calls on one immutable inventory and path list. */
export function selectTests(
  input: { files: Map<string, string>; paths: string[] },
  graphCache?: object,
): TestSelection;
export type PreflightTier = {
  tier: 'mandatory' | 'learned' | 'direct' | 'wide' | 'recent' | 'watch' | 'near';
  tests: string[];
};
export const preflightTierRule: string;
/** Export names whose declaring statement differs between two texts of a module (or one side lacks). */
export function changedExports(path: string, before: string, after: string): string[];
/** Exports a change can alter, helpers included; '*' is the whole module. */
export function alteredSurface(path: string, before: string, after: string): string[];
/** Name literals of `before` that `after` no longer holds. */
export function removedNames(path: string, before: string, after: string): string[];
/** A test file named for a budget, cost, registration or contract guard (on its own name). */
export function contractGuardTest(test: string): boolean;
/** Seconds of contract pins one plan promotes into the protected tier. */
export const CONTRACT_PIN_SECONDS: number;
/** Tiers the time budget never trims from the plan; the run starts them first. */
export const protectedTiers: Set<string>;
export function selectPreflightTests(
  input: {
    files: Map<string, string>;
    paths: string[];
    /** Tests that failed for one of these paths in an earlier landing check or preflight. */
    learned?: string[];
    /** Tests that failed in a landing check lately under other paths. Those that run a changed
     * module within two product modules are ranked after `wide` (`recent`); among equally close
     * direct and wide tests they go first. */
    recent?: string[];
    /** Changed paths whose bytes equal their base outside comments: they add only the tests that
     * read their text, never their importers. */
    commentOnly?: string[];
    /** Project-declared guard tests this change triggers; mandatory, so never trimmed. */
    guards?: string[];
    /** Name literals the change removed from changed files: tests that hard-code one are direct. */
    removedNames?: string[];
    /** Export names the change altered, per changed module: tests that import one by name are direct. */
    changedExports?: Map<string, string[]>;
    /** Protect direct tests module by module, most specific first, while their cost fits; the
     * rest are broad modules whose consumers are ranked (`wide`). Absent: all are protected. */
    hubBudget?: { seconds: number; secondsFor: (test: string) => number };
  },
  graphCache?: object,
): TestSelection & {
  deferredTests: string[];
  tiers: PreflightTier[];
  /** Changed modules whose direct tests were ranked (`wide`) instead of protected. */
  broadModules: string[];
  /** Budget, cost, registration and contract tests the change reaches, promoted into the mandatory tier. */
  pins: string[];
  /** The registration and inventory pins of a backend change, which start early even untimed. */
  pinsFirst: string[];
  /** Distinctive names each promoted `watch` test shares with a changed source. */
  watchedNames: Record<string, string[]>;
  /** [product hops, carrier fan-in, helper hops] of each direct, wide and near test; lower is closer. */
  ranks: Record<string, [number, number, number]>;
  /** [recent failure, name affinity 0-100, mentions of a changed module] of each local direct, wide, recent and near test: the tie-break between equally close tests. */
  relevance: Record<string, [number, number, number]>;
  /** The `recent` input tests that qualified (consumers within two product modules). */
  recentFailed: string[];
  commentOnly?: string[];
  /** Protected tests that are the change's own test files, then tests named for a changed module. */
  leadTests?: string[];
  /** Protected tests that scan a folder holding a changed file (repo-wide guards). */
  treeGuards?: string[];
  /** Direct and learned tests that load each protected changed module (through test fixtures too),
   * most specific module (fewest loaders) first, then those that run each through one module in the
   * same order; the run starts them right after the change's own tests (src/preflight-run-order.ts). */
  specificModules?: { path: string; tests: string[] }[];
};
export function fitPreflightBudget(input: {
  tiers: PreflightTier[];
  budgetSeconds: number;
  secondsPerFile: number;
  /** Cost of one test file in seconds when it is known; defaults to `secondsPerFile`. */
  secondsFor?: (test: string) => number;
  free?: Set<string>;
}): {
  tests: string[];
  trimmed: {
    tier: PreflightTier['tier'];
    kept: number;
    total: number;
    deferred: string[];
  }[];
  estimateSeconds: number;
  mandatoryOverBudget: boolean;
  /** Protected tiers alone exceed the budget; the plan keeps them all, the run's wall clock stops them. */
  protectedOverBudget: boolean;
};
export function selectImpactPair(
  files: Map<string, string>,
  comparisons: string[][],
  graphCache?: object,
): TestSelection[];
export const smokeTests: string[];
export function documentation(path: string): boolean;
