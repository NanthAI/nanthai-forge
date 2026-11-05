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

export function selectionSourcePath(path: string): boolean;

export function selectTests(input: { files: Map<string, string>; paths: string[] }): TestSelection;
export type PreflightTier = {
  tier: 'mandatory' | 'direct' | 'near';
  tests: string[];
};
export const preflightTierRule: string;
export function selectPreflightTests(input: {
  files: Map<string, string>;
  paths: string[];
}): TestSelection & { deferredTests: string[]; tiers: PreflightTier[] };
export function fitPreflightBudget(input: {
  tiers: PreflightTier[];
  budgetSeconds: number;
  secondsPerFile: number;
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
};
export function selectImpactPair(files: Map<string, string>, comparisons: string[][]): TestSelection[];
export const smokeTests: string[];
export function documentation(path: string): boolean;
