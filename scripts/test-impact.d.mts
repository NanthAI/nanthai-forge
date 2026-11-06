// SPDX-License-Identifier: Apache-2.0
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
  tier: 'mandatory' | 'learned' | 'direct' | 'recent' | 'wide' | 'watch' | 'near';
  tests: string[];
};
export const preflightTierRule: string;
/** Tiers the time budget never trims or stops. */
export const protectedTiers: Set<string>;
export function selectPreflightTests(
  input: {
    files: Map<string, string>;
    paths: string[];
    /** Tests that failed for one of these paths in an earlier landing check or preflight. */
    learned?: string[];
    /** Tests that failed in a landing check lately under other paths; consumers of this change
     * among them are ranked before `wide` and trimmed by time like it (`recent`). */
    recent?: string[];
    /** Project-declared guard tests this change triggers; mandatory, so never trimmed. */
    guards?: string[];
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
  /** Distinctive names each promoted `watch` test shares with a changed source. */
  watchedNames: Record<string, string[]>;
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
  /** Protected tiers alone exceed the budget; they still all run. */
  protectedOverBudget: boolean;
};
export function selectImpactPair(files: Map<string, string>, comparisons: string[][]): TestSelection[];
export const smokeTests: string[];
export function documentation(path: string): boolean;
